package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	mathrand "math/rand"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/valtech-sdv/vehicle-client/telemetry"
	pbMetrics "github.com/valtech-sdv/vehicle-client/telemetry"
	pbVehicle "github.com/valtech-sdv/vehicle-client/telemetry"
)

// RegistrationResponse is returned by the registration server
type RegistrationResponse struct {
	Certificate string `json:"certificate"`
	KeycloakURL string `json:"keycloak_url"`
	NatsURL     string `json:"nats_url"`
}

// KeycloakTokenResponse contains the JWT token from Keycloak
type KeycloakTokenResponse struct {
	AccessToken      string `json:"access_token"`
	IDToken          string `json:"id_token,omitempty"`
	RefreshToken     string `json:"refresh_token,omitempty"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
	TokenType        string `json:"token_type"`
}

// VehicleClient handles the complete vehicle authentication flow
type VehicleClient struct {
	VIN                   string
	pkiStrategy           string
	FactoryCertFile       string
	FactoryKeyFile        string
	RegistrationServerURL string
	MessageType           string // "telemetry", "metrics_report", or "both"
	controlSubject        string // NATS subject for start/stop commands ("" = publish immediately)

	// Generated during registration
	operationalCert    *x509.Certificate
	operationalKey     *rsa.PrivateKey
	operationalCertPEM []byte
	keycloakURL        string
	natsURL            string

	// Per-VIN degradation state shared with the control handler: the tires
	// trajectory (read by buildPayloads → buildChassisReport) and the
	// vehicle's simulated age (also maintained in batteryState.ageDays).
	tiresDeg       *DegradationConfig
	batteryAgeDays float64

	// groundTruthLabels is the path of the JSONL file the publish loop
	// appends one ground-truth object per VIN per tick to (offline evaluator
	// input). Empty string disables the writer.
	groundTruthLabels string
}

// --- Randomized drive simulation -------------------------------------------

type driveState struct {
	velocity       float64
	engineRPM      float64
	enginePower    float64
	fuelLevel      float64
	steeringAngle  float64
	acceleratorPct float64
	brakePct       float64
	phase          int     // 0 accelerate, 1 cruise, 2 brake, 3 idle
	phaseLeft      float64 // seconds remaining in current phase
	cruiseTarget   float64 // m/s cruise target — city ~50 or highway ~90 km/h
	tripDist       float64 // metres travelled along the trip route
	lat            float64
	lng            float64
	headingDeg     float64 // degrees clockwise from north (road direction)
	brakeEnergyJ   float64 // accumulated brake energy (m·|decel|·v·dt), ground truth
}

type batteryState struct {
	voltage float64
	current float64
	soc     float64
	temp    float64
	deg     *DegradationConfig // per-VIN degradation trajectory (nil = no degradation)
	ageDays float64            // simulated age of the battery in days
}

type publishMsg struct {
	kind    string // "telemetry" or "metrics_report" (used for logging only)
	subject string
	payload []byte
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func parseVINPool(raw string) []string {
	var pool []string
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		if part != "" {
			pool = append(pool, part)
		}
	}
	return pool
}

func randomVinFromPool(pool []string) string {
	if len(pool) == 0 {
		return "VIN1001"
	}
	return pool[mathrand.Intn(len(pool))]
}

// poolIndex returns the index of vin in the VIN_POOL env pool, or -1 when
// the VIN is not in the pool (no pool env / custom -vin). Used to give the
// fleet a deterministic degradation spread in demo mode.
// gauss returns a sample from a zero-mean normal distribution with the
// given standard deviation (Box-Muller). Real vehicle sensors read Gaussian
// noise — thermal jitter, ADC quantization, EM pickup — not uniform jitter;
// a uniform spread reads as "synthetic" on a zoomed chart and over-smooths
// the PM EWMA. Box-Muller keeps it dependency-free.
func gauss(stddev float64) float64 {
	u1 := 1.0 - mathrand.Float64()
	u2 := mathrand.Float64()
	return stddev * math.Sqrt(-2.0*math.Log(u1)) * math.Cos(2.0*math.Pi*u2)
}

func poolIndex(vin string) int {
	pool := parseVINPool(os.Getenv("VIN_POOL"))
	for i, v := range pool {
		if v == vin {
			return i
		}
	}
	return -1
}

func newDriveState() driveState {
	lat, lng, heading := simTrip.positionAt(0)
	return driveState{
		fuelLevel:     20 + mathrand.Float64()*60,
		phase:         0,
		phaseLeft:     5 + mathrand.Float64()*10,
		cruiseTarget:  50.0 / 3.6,
		tripDist:      0,
		lat:           lat,
		lng:           lng,
		headingDeg:    heading,
		steeringAngle: (mathrand.Float64() - 0.5) * 4,
	}
}

// driveCycleStep advances the drive profile by dt seconds. Velocity follows a
// smooth accelerate/cruise/brake/idle cycle; derived sensors correlate.
// speed > 1 (demo fast-forward) scales the travelled distance and brake
// energy — the two quantities that feed the route/lap counter and the brake
// wear detector — while velocity/sensor values stay at normal scale.
func driveCycleStep(s *driveState, dt, speed float64) {
	s.phaseLeft -= dt
	if s.phaseLeft <= 0 {
		s.phase = (s.phase + 1) % 4
		switch s.phase {
		case 0:
			s.phaseLeft = 6 + mathrand.Float64()*12 // accelerate
		case 1:
			s.phaseLeft = 8 + mathrand.Float64()*15 // cruise
			// 55 % city (~50 km/h), 45 % highway (~90 km/h).
			if mathrand.Float64() < 0.55 {
				s.cruiseTarget = 50.0 / 3.6
			} else {
				s.cruiseTarget = 90.0 / 3.6
			}
		case 2:
			s.phaseLeft = 4 + mathrand.Float64()*8 // brake
		case 3:
			s.phaseLeft = 3 + mathrand.Float64()*6 // idle
		}
	}

	switch s.phase {
	case 0: // accelerate
		s.velocity += 1.5 * dt
		s.acceleratorPct = clamp(40+mathrand.Float64()*40, 0, 100)
		s.brakePct = 0
	case 1: // cruise
		s.velocity += (mathrand.Float64() - 0.5) * 0.6 * dt
		s.acceleratorPct = clamp(15+mathrand.Float64()*20, 0, 100)
		s.brakePct = 0
		// Realistic speed envelope: hold the cruise target (a mix of
		// city ~50 and highway ~90 km/h, picked at phase start), not an
		// unbounded climb toward 200. This keeps the profile looking like
		// real driving on a zoomed speed chart.
		if s.velocity > s.cruiseTarget {
			s.velocity -= 0.8 * dt
			s.acceleratorPct = 8 // light maintenance throttle
		}
	case 2: // brake
		vStart := s.velocity
		s.velocity -= 3.0 * dt
		s.acceleratorPct = 0
		s.brakePct = clamp(20+mathrand.Float64()*40, 0, 100)
		// Accumulate brake energy (ground truth for the brake detector) with
		// the trapezoidal m·|a|·v_avg·Δt over the step — algebraically
		// identical to the processor's velocity-delta estimate
		// (m·|Δv|·v_avg, mass 1500 kg), so detector and truth stay
		// comparable. Only count when the brake is engaged (pct > 5) and
		// the vehicle is still moving.
		if s.brakePct > 5 && s.velocity > 0.5 {
			vAvg := 0.5 * (vStart + s.velocity)
			s.brakeEnergyJ += speed * 1500.0 * math.Abs(s.velocity-vStart) * vAvg
		}
	case 3: // idle
		s.velocity -= 0.5 * dt
		s.acceleratorPct = 0
		s.brakePct = 0
	}
	s.velocity = clamp(s.velocity, 0, 130.0/3.6) // 130 km/h hard cap (autobahn-ish)
	s.brakePct = clamp(s.brakePct, 0, 100)

	// Derived engine state.
	targetRPM := 800 + s.velocity*35 + s.acceleratorPct*8
	s.engineRPM = clamp(targetRPM+(mathrand.Float64()-0.5)*150, 0, 6000)
	s.enginePower = clamp(s.velocity*0.35+s.acceleratorPct*0.8+(mathrand.Float64()-0.5)*5, 0, 150)
	s.fuelLevel -= dt * 0.002 * (0.5 + s.engineRPM/4000)
	if s.fuelLevel < 5 {
		s.fuelLevel = 60
	}
	s.steeringAngle = clamp(s.steeringAngle+(mathrand.Float64()-0.5)*0.8, -45, 45)

	// Advance along the real trip route: distance = velocity * dt * speed
	// (demo fast-forward laps the route faster), position interpolated on
	// the embedded street loop, heading following the road.
	s.tripDist += s.velocity * dt * speed
	s.lat, s.lng, s.headingDeg = simTrip.positionAt(s.tripDist)
}

// brakeWearFraction returns the fraction of the pad-life energy budget
// consumed so far (ground truth for the brake detector). Clamped to [0,1]
// so the processor's detect_brake(min(1, E/E_budget)) comparison stays valid.
func (s *driveState) brakeWearFraction() float64 {
	f := s.brakeEnergyJ / brakeEnergyBudgetJ
	return clamp(f, 0, 1)
}

// buildBatteryTelemetry constructs the TelemetryMessage with the battery
// readings (battery component only — cabin static readings are a separate
// message, see buildCabinTelemetry).
func buildBatteryTelemetry(vin string, b batteryState, now time.Time) (*pb.TelemetryMessage, error) {
	return &pb.TelemetryMessage{
		MessageId:     uuid.New().String(),
		SchemaVersion: 1,
		DeviceId:      vin,
		SensorData: []*pb.SensorReading{
			{
				Timestamp: timestamppb.New(now),
				Value:     fmt.Sprintf("%.2f", b.voltage),
				DataType:  pb.DataType_DYNAMIC,
				Sensor:    "battery.voltage",
			},
			{
				Timestamp: timestamppb.New(now),
				Value:     fmt.Sprintf("%.2f", b.current),
				DataType:  pb.DataType_DYNAMIC,
				Sensor:    "battery.current",
			},
			{
				Timestamp: timestamppb.New(now),
				Value:     fmt.Sprintf("%.2f", b.soc),
				DataType:  pb.DataType_DYNAMIC,
				Sensor:    "battery.soc",
			},
			{
				Timestamp: timestamppb.New(now),
				Value:     fmt.Sprintf("%.2f", b.temp),
				DataType:  pb.DataType_DYNAMIC,
				Sensor:    "battery.temp",
			},
			{
				// Legacy telemetry-path TIRE_TEMP (b.temp carries TireTempAt
				// from the publish loop). The typed path — proto field 16 →
				// dynamic:TIRE_TEMP — is emitted in buildChassisReport.
				Timestamp: timestamppb.New(now),
				Value:     fmt.Sprintf("%.2f", b.temp),
				DataType:  pb.DataType_DYNAMIC,
				Sensor:    "TIRE_TEMP",
			},
		},
	}, nil
}

// buildCabinTelemetry constructs the static cabin/identity readings
// (make/model/year/firmware).
func buildCabinTelemetry(vin string, now time.Time) (*pb.TelemetryMessage, error) {
	return &pb.TelemetryMessage{
		MessageId:     uuid.New().String(),
		SchemaVersion: 1,
		DeviceId:      vin,
		SensorData: []*pb.SensorReading{
			{
				Timestamp: timestamppb.New(now),
				Value:     "Nexus SDV",
				DataType:  pb.DataType_STATIC,
				Sensor:    "make",
			},
			{
				Timestamp: timestamppb.New(now),
				Value:     "SDV-1",
				DataType:  pb.DataType_STATIC,
				Sensor:    "model",
			},
			{
				Timestamp: timestamppb.New(now),
				Value:     "2026",
				DataType:  pb.DataType_STATIC,
				Sensor:    "year",
			},
			{
				Timestamp: timestamppb.New(now),
				Value:     "1.2.0",
				DataType:  pb.DataType_STATIC,
				Sensor:    "firmware",
			},
		},
	}, nil
}

// f32 returns a pointer to v — helper for proto3 optional float fields.
func f32(v float32) *float32 { return &v }

// buildPowertrainReport constructs a MetricsReport with only the powertrain
// fields (engine power/rpm, fuel). Publishing it separately from the chassis
// report lets the dashboard stop one component without starving the other;
// fields of disabled components are absent (nil), never zero.
func buildPowertrainReport(vin string, drive driveState, now time.Time, count int) (*pbMetrics.MetricsReport, error) {
	vehicleData := &pbVehicle.VehicleTelemetryData{
		ENGINE_POWER:  f32(float32(drive.enginePower)),
		ENGINE_RPM:    f32(float32(drive.engineRPM)),
		FUEL_CAPACITY: f32(50.0), // Static value
		FUEL_LEVEL:    f32(float32(drive.fuelLevel)),
	}
	return wrapMetricsReport(vin, now, count, vehicleData)
}

// buildChassisReport constructs a MetricsReport with only the chassis/dynamics
// fields (velocity, tire pressure/temperature, GPS, steering/pedals, ignition).
// tires is the per-VIN degradation config for the tires component (may be
// nil in tests — falls back to the legacy constant + noise) and ageDays the
// vehicle's simulated age used to walk the tire-leak/temperature curves.
// Per-wheel tire pressure/temperature ride the generic TelemetryMessage path
// (dynamic:TIRE_PRESSURE.FL..RR / TIRE_TEMP.FL..RR — see
// buildChassisWheelTelemetry), while the legacy single TIRE_PRESSURE/TIRE_TEMP
// typed fields stay for back-compat (the /pm provisional health and the
// detector's single-channel fallback consume them).
func buildChassisReport(vin string, drive driveState, tires *DegradationConfig, ageDays float64, now time.Time) (*pbMetrics.MetricsReport, error) {
	ignitionState := drive.engineRPM > 0
	gpsLat := float32(drive.lat)
	gpsLon := float32(drive.lng)
	tirePressure := 2.2 + gauss(0.02)
	tireTemp := 28.0 + gauss(0.3)
	if tires != nil {
		tirePressure = tires.TirePressureAt("FL", ageDays)
		tireTemp = tires.TireTempAt("FL", ageDays)
	}

	vehicleData := &pbVehicle.VehicleTelemetryData{
		VELOCITY:       f32(float32(drive.velocity)),
		TIRE_PRESSURE:  f32(float32(tirePressure)),
		TIRE_TEMP:      f32(float32(tireTemp)),
		IGNITION_STATE: &ignitionState,
		GPS_LATITUDE:   &gpsLat,
		GPS_LONGITUDE:  &gpsLon,
		HEADING_DEG:    f32(float32(drive.headingDeg)),
		VehicleDynamics: &pbVehicle.CarlaVehicleDynamics{
			SteeringAngleDeg:    drive.steeringAngle,
			AcceleratorPedalPct: drive.acceleratorPct,
			BrakePedalPct:       drive.brakePct,
		},
	}
	return wrapMetricsReport(vin, now, 0, vehicleData)
}

// buildChassisWheelTelemetry emits one TelemetryMessage per wheel carrying
// that corner's per-wheel sensors (TIRE_PRESSURE.<wheel>, TIRE_TEMP.<wheel>,
// BRAKE_WEAR.<wheel>). These ride the generic telemetry-generic path so the
// connector stores them as dynamic:<name> columns without any connector
// change; the detector polls them for per-wheel / per-pad PM (pm.{VIN}.tires.
// {wheel}, pm.{VIN}.brake.{pad}). A nil tires config falls back to the legacy
// constant + noise for pressure/temp; brake wear is always emitted from the
// drive state's energy accumulator.
func buildChassisWheelTelemetry(vin string, drive driveState, tires *DegradationConfig, ageDays float64, now time.Time) ([]*pb.TelemetryMessage, error) {
	var out []*pb.TelemetryMessage
	for _, wheel := range wheels {
		pressure := 2.2 + gauss(0.02)
		temp := 28.0 + gauss(0.3)
		if tires != nil {
			pressure = tires.TirePressureAt(wheel, ageDays)
			temp = tires.TireTempAt(wheel, ageDays)
		}
		msg := &pb.TelemetryMessage{
			MessageId:     uuid.New().String(),
			SchemaVersion: 1,
			DeviceId:      vin,
			SensorData: []*pb.SensorReading{
				{
					Timestamp: timestamppb.New(now),
					Value:     fmt.Sprintf("%.2f", pressure),
					DataType:  pb.DataType_DYNAMIC,
					Sensor:    "TIRE_PRESSURE." + wheel,
				},
				{
					Timestamp: timestamppb.New(now),
					Value:     fmt.Sprintf("%.2f", temp),
					DataType:  pb.DataType_DYNAMIC,
					Sensor:    "TIRE_TEMP." + wheel,
				},
				{
					Timestamp: timestamppb.New(now),
					Value:     fmt.Sprintf("%.4f", drive.brakeWearFraction()),
					DataType:  pb.DataType_DYNAMIC,
					Sensor:    "BRAKE_WEAR." + wheel,
				},
			},
		}
		out = append(out, msg)
	}
	return out, nil
}

// wrapMetricsReport wraps VehicleTelemetryData in the MetricsReport envelope.
func wrapMetricsReport(vin string, now time.Time, count int, vehicleData *pbVehicle.VehicleTelemetryData) (*pbMetrics.MetricsReport, error) {
	anyPayload, err := anypb.New(vehicleData)
	if err != nil {
		return nil, fmt.Errorf("failed to create Any payload: %w", err)
	}

	return &pbMetrics.MetricsReport{
		ReportNumber:         int32(count) + 1,
		ReportTimestamp:      timestamppb.New(now),
		ReportReason:         pbMetrics.MetricsReport_REGULAR,
		MetricsConfigUuid:    uuid.New().String(),
		MetricsConfigVersion: 1,
		ReportConfigName:     "default",
		ReportData:           anyPayload,
		ReportUuid:           uuid.New().String(),
	}, nil
}

// buildPayloads constructs the NATS publish messages for one simulation tick
// for the requested message type and the currently enabled components.
// "telemetry" emits battery/cabin TelemetryMessages, "metrics_report" the
// powertrain/chassis MetricsReports, and "both" emits all enabled ones.
func (v *VehicleClient) buildPayloads(now time.Time, battery batteryState, drive driveState, messageType string, count int, enabled func(string) bool) []publishMsg {
	var out []publishMsg
	emit := func(kind, subject string, payload []byte) {
		if payload != nil {
			out = append(out, publishMsg{kind: kind, subject: subject, payload: payload})
		}
	}
	if messageType == "telemetry" || messageType == "both" {
		if enabled("battery") {
			if msg, err := buildBatteryTelemetry(v.VIN, battery, now); err == nil {
				if payload, err := proto.Marshal(msg); err == nil {
					emit("telemetry", v.buildTelemetrySubject("battery"), payload)
				}
			}
		}
		if enabled("cabin") {
			if msg, err := buildCabinTelemetry(v.VIN, now); err == nil {
				if payload, err := proto.Marshal(msg); err == nil {
					emit("telemetry", v.buildTelemetrySubject("cabin"), payload)
				}
			}
		}
		if enabled("chassis") {
			// Per-wheel tire/brake sensors ride the generic telemetry path
			// (the connector writes dynamic:TIRE_PRESSURE.{wheel} etc.); the
			// MetricsReport chassis report keeps the legacy single-channel
			// typed fields for back-compat.
			if msgs, err := buildChassisWheelTelemetry(v.VIN, drive, v.tiresDeg, v.batteryAgeDays, now); err == nil {
				for _, msg := range msgs {
					if payload, err := proto.Marshal(msg); err == nil {
						emit("telemetry", v.buildTelemetrySubject("chassis"), payload)
					}
				}
			}
		}
	}
	if messageType == "metrics_report" || messageType == "both" {
		if enabled("powertrain") {
			if report, err := buildPowertrainReport(v.VIN, drive, now, count); err == nil {
				if payload, err := proto.Marshal(report); err == nil {
					emit("metrics_report", v.buildMetricsReportSubject(), payload)
				}
			}
		}
		if enabled("chassis") {
			if report, err := buildChassisReport(v.VIN, drive, v.tiresDeg, v.batteryAgeDays, now); err == nil {
				if payload, err := proto.Marshal(report); err == nil {
					emit("metrics_report", v.buildMetricsReportSubject(), payload)
				}
			}
		}
	}
	return out
}

// groundTruth computes the live ground-truth values for the control status
// reply, derived from the same curves the published telemetry walks so the
// evaluator can compare detector output against truth:
//
//	battery: wear_fraction (SoH loss from the V_rest decline) and
//	         days_to_failure (time remaining on the preset's horizon)
//	brake:   wear_fraction (E/E_budget from the brake accumulator)
//	tires:   pressure (bar) + temp (°C) on the tire-leak/temp curves
//
// Components with no degradation config are omitted.
func (v *VehicleClient) groundTruth(battery batteryState, drive driveState) map[string]map[string]any {
	gt := map[string]map[string]any{}
	if battery.deg != nil {
		vRest, _, _ := battery.deg.BatteryAt(battery.ageDays)
		// Wear = distance along the V_rest decline from healthy (12.63 V)
		// to fully degraded (12.0 V); healthy VINs stay ~0. Past the
		// horizon the death collapse drives V_rest below 12.0 V, so clamp
		// the fraction to 1.0 — a dead battery is 100 % worn, never 123 %.
		wear := clamp((12.63-vRest)/0.63, 0, 1)
		daysToFailure := (1 - battery.deg.norm(battery.ageDays)) * float64(battery.deg.horizonDays())
		if battery.ageDays >= float64(battery.deg.horizonDays()) {
			daysToFailure = 0 // death collapse: the battery is already dead
		}
		gt["battery"] = map[string]any{
			"wear_fraction":   math.Round(wear*1000) / 1000,
			"days_to_failure": int(math.Round(daysToFailure)),
		}
	}
	gt["brake"] = map[string]any{
		"wear_fraction": math.Round(drive.brakeWearFraction()*1000) / 1000,
		"energy_joules": int64(drive.brakeEnergyJ),
	}
	// Per-pad brake wear: the same accumulator scaled per pad (front pads do
	// more work under braking) so the FL pad — the worst corner — crosses
	// the detector's action threshold first. BrakeWearAt reads no config
	// state, so a nil tires config is safe (bare &DegradationConfig{}).
	brakeDeg := v.tiresDeg
	if brakeDeg == nil {
		brakeDeg = &DegradationConfig{}
	}
	brakes := map[string]any{}
	for _, wheel := range wheels {
		brakes[wheel] = map[string]any{
			"wear_fraction": math.Round(brakeDeg.BrakeWearAt(wheel, drive.brakeEnergyJ)*1000) / 1000,
		}
	}
	gt["brakes"] = brakes
	if v.tiresDeg != nil {
		// Legacy flat tires ground truth stays (the labels evaluator and the
		// /pm provisional health consume it), using the FL corner as the
		// representative; per-wheel entries sit directly under tires.
		tiresGT := map[string]any{
			"pressure_bar": math.Round(v.tiresDeg.TirePressureAt("FL", v.batteryAgeDays)*100) / 100,
			"temp_c":       math.Round(v.tiresDeg.TireTempAt("FL", v.batteryAgeDays)*10) / 10,
		}
		for _, wheel := range wheels {
			tiresGT[wheel] = map[string]any{
				"pressure_bar": math.Round(v.tiresDeg.TirePressureAt(wheel, v.batteryAgeDays)*100) / 100,
				"temp_c":       math.Round(v.tiresDeg.TireTempAt(wheel, v.batteryAgeDays)*10) / 10,
			}
		}
		gt["tires"] = tiresGT
	}
	return gt
}

// writeGroundTruthLabels appends one JSON object per VIN per tick to the
// labels file, matching collect_ground_truth's schema in
// sample-services/predictive-maintenance/scripts/evaluate_detectors.py:
//
//	{"vin": "VIN1001", "t_epoch": 1728000000.0,
//	 "battery": {"wear_fraction": 0.42, "days_to_failure": 69},
//	 "brake":   {"wear_fraction": 0.12, "energy_joules": 720000000},
//	 "tires":   {"pressure_bar": 2.10, "temp_c": 30.0}}
//
// Fields mirror the status reply's ground_truth (the same curves the
// published telemetry walks), so the evaluator can compare detector output
// against truth. No labels path configured = no-op. Appends (never
// truncates) so a soak's labels survive simulator restarts; write errors are
// logged and skipped, never fatal — ground truth is best-effort bookkeeping.
func (v *VehicleClient) writeGroundTruthLabels(now time.Time, battery batteryState, drive driveState) {
	if v.groundTruthLabels == "" {
		return
	}
	rec := map[string]any{
		"vin":     v.VIN,
		"t_epoch": float64(now.UnixNano()) / 1e9,
	}
	for component, fields := range v.groundTruth(battery, drive) {
		rec[component] = fields
	}
	line, err := json.Marshal(rec)
	if err != nil {
		log.Printf("Failed to marshal ground-truth label: %v", err)
		return
	}
	f, err := os.OpenFile(v.groundTruthLabels, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("Failed to open ground-truth labels file %s: %v", v.groundTruthLabels, err)
		return
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		log.Printf("Failed to write ground-truth label: %v", err)
	}
}

// --- NATS control mode ------------------------------------------------------

// sensorInfo is one publishable signal of a component. Name matches the
// Bigtable column qualifier / MetricsReport field; Label and Unit are the
// dashboard's display metadata (empty unit = plain value).
type sensorInfo struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Unit  string `json:"unit,omitempty"`
}

// componentState is one independently controllable telemetry component.
// The dashboard discovers components from this list (status reply) — no
// frontend knowledge of sensors is required.
type componentState struct {
	id      string
	label   string
	enabled bool
	sensors []sensorInfo
}

// controlState tracks start/stop/status commands received on the control
// subject. In control mode the publish loop only emits telemetry for enabled
// components; control messages are plain JSON on the control subject and
// replies go to the request's reply subject.
type controlState struct {
	mu          sync.Mutex
	running     bool
	published   int64
	startedAt   time.Time
	vin         string
	messageType string
	components  map[string]*componentState
	replyFn     func(msg *nats.Msg, body map[string]any)

	// Per-component degradation configs (battery/tires only — the components
	// whose trajectories the simulator walks). Defaults come from the VIN's
	// DEGRADATION_PRESET; the "degradation" control action rewrites them.
	// Non-degradable components keep nil entries so the status reply omits
	// their ground truth.
	degradation map[string]*DegradationConfig
	// groundTruth holds the live simulator values the status reply exposes
	// (see stateLocked). Set by the publish loop each tick; only components
	// with an enabled config are populated.
	groundTruth map[string]map[string]any
	// speed is the demo-speed multiplier (DEMO_SPEED env, or the "speed"
	// control action). It accelerates simulation time — degradation accrual,
	// trip progress and brake energy — while the published sensor values stay
	// at normal scale. 1 = real-time, 5 = fast demo, 20 = showcase.
	speed float64
	// routeDist is the latest travelled distance along the trip loop (m),
	// recorded by the publish loop each tick for the status reply's lap
	// computation.
	routeDist float64
	// live carries the current drive-state values the /pm console displays:
	// velocity (m/s), tire pressure (bar), GPS position and battery voltage.
	// Set by the publish loop each tick (see setLive).
	live map[string]any
	// resetFn re-initializes the drive/battery state owned by the publish
	// loop (battery age 0, fresh drive cycle, zeroed brake accumulator).
	// Set once by PublishTelemetryContinuously; "reset" control action calls
	// it so the demo restarts from a known healthy state.
	resetFn func()
	// degradationAccel multiplies simulated aging beyond the demo-speed
	// multiplier (DEGRADATION_ACCEL env, default 1). The demo sets it high
	// so component health visibly trends downward within a 1-3 minute
	// showcase instead of the real-time horizon.
	degradationAccel float64
}

// defaultDegradationConfig returns the per-VIN default DegradationConfig for
// a degradable component. The preset comes from the DEGRADATION_PRESET env
// var: "demo" (default) gives the fleet spread — healthy for odd pool
// indices, degrading for even, critical for the last pool member (the
// dedicated demo VIN that shows an alert within a poll cycle). "healthy",
// "degrading" and "critical" apply uniformly to every VIN.
func defaultDegradationConfig(component string, poolIndex int) *DegradationConfig {
	preset := os.Getenv("DEGRADATION_PRESET")
	if preset == "" || preset == "demo" {
		switch {
		case poolIndex < 0:
			preset = "healthy"
		case poolIndex%2 == 1:
			preset = "healthy"
		case poolIndex == 0:
			preset = "critical"
		default:
			preset = "degrading"
		}
	}
	switch preset {
	case "healthy", "degrading", "critical":
	default:
		preset = "healthy"
	}
	horizon := 120
	if preset == "critical" {
		horizon = 60
	}
	return &DegradationConfig{Component: component, Preset: preset, HorizonDays: horizon}
}

// degradableComponents are the components whose trajectories the simulator
// walks (battery via publishOnce, tires via buildChassisReport) and that the
// degradation control action can rewrite.
var degradableComponents = []string{"battery", "tires"}

// newControlState builds the component registry. This is the single source
// of truth for what the simulator can stream; keep in sync with the payload
// builders in buildPayloads.
func newControlState(vin, messageType string) *controlState {
	poolIndex := poolIndex(vin)
	degradation := map[string]*DegradationConfig{}
	for _, comp := range degradableComponents {
		degradation[comp] = defaultDegradationConfig(comp, poolIndex)
	}
	speed := 1.0
	if v := os.Getenv("DEMO_SPEED"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n >= 1 {
			speed = n
		}
	}
	accel := 1.0
	if v := os.Getenv("DEGRADATION_ACCEL"); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n >= 1 {
			accel = n
		}
	}
	return &controlState{
		vin:              vin,
		messageType:      messageType,
		degradation:      degradation,
		groundTruth:      map[string]map[string]any{},
		live:             map[string]any{},
		speed:            speed,
		degradationAccel: accel,
		components: map[string]*componentState{
			"battery": {
				id: "battery", label: "Battery",
				sensors: []sensorInfo{
					{Name: "battery.voltage", Label: "Voltage", Unit: "V"},
					{Name: "battery.current", Label: "Current", Unit: "A"},
					{Name: "battery.soc", Label: "SoC", Unit: "%"},
					{Name: "battery.temp", Label: "Temp", Unit: "°C"},
				},
			},
			"cabin": {
				id: "cabin", label: "Cabin",
				sensors: []sensorInfo{
					{Name: "make", Label: "Make"},
					{Name: "model", Label: "Model"},
					{Name: "year", Label: "Year"},
					{Name: "firmware", Label: "Firmware"},
				},
			},
			"powertrain": {
				id: "powertrain", label: "Powertrain",
				sensors: []sensorInfo{
					{Name: "ENGINE_POWER", Label: "Power", Unit: "W"},
					{Name: "ENGINE_RPM", Label: "RPM", Unit: "rpm"},
					{Name: "FUEL_CAPACITY", Label: "Fuel capacity", Unit: "L"},
					{Name: "FUEL_LEVEL", Label: "Fuel", Unit: "%"},
				},
			},
			"chassis": {
				id: "chassis", label: "Chassis",
				sensors: []sensorInfo{
					{Name: "VELOCITY", Label: "Velocity", Unit: "m/s"},
					{Name: "TIRE_PRESSURE", Label: "Tire pressure", Unit: "bar"},
					{Name: "TIRE_PRESSURE.FL", Label: "Tire pressure FL", Unit: "bar"},
					{Name: "TIRE_PRESSURE.FR", Label: "Tire pressure FR", Unit: "bar"},
					{Name: "TIRE_PRESSURE.RL", Label: "Tire pressure RL", Unit: "bar"},
					{Name: "TIRE_PRESSURE.RR", Label: "Tire pressure RR", Unit: "bar"},
					{Name: "TIRE_TEMP", Label: "Tire temp", Unit: "°C"},
					{Name: "TIRE_TEMP.FL", Label: "Tire temp FL", Unit: "°C"},
					{Name: "TIRE_TEMP.FR", Label: "Tire temp FR", Unit: "°C"},
					{Name: "TIRE_TEMP.RL", Label: "Tire temp RL", Unit: "°C"},
					{Name: "TIRE_TEMP.RR", Label: "Tire temp RR", Unit: "°C"},
					{Name: "BRAKE_WEAR.FL", Label: "Brake wear FL", Unit: "%"},
					{Name: "BRAKE_WEAR.FR", Label: "Brake wear FR", Unit: "%"},
					{Name: "BRAKE_WEAR.RL", Label: "Brake wear RL", Unit: "%"},
					{Name: "BRAKE_WEAR.RR", Label: "Brake wear RR", Unit: "%"},
					{Name: "GPS_LATITUDE", Label: "Latitude"},
					{Name: "GPS_LONGITUDE", Label: "Longitude"},
					{Name: "HEADING_DEG", Label: "Heading", Unit: "°"},
					{Name: "STEERING_ANGLE_DEG", Label: "Steering", Unit: "°"},
					{Name: "ACCELERATOR_PEDAL_PCT", Label: "Accelerator", Unit: "%"},
					{Name: "BRAKE_PEDAL_PCT", Label: "Brake", Unit: "%"},
				},
			},
		},
		replyFn: func(msg *nats.Msg, body map[string]any) {
			data, _ := json.Marshal(body)
			_ = msg.Respond(data)
		},
	}
}

// handle processes one control request:
// {"action":"start"|"stop"|"status"|"degradation","component":"<id>",
//
//	"preset":"healthy|degrading|critical"}. The component field is optional —
//
// without it start/stop apply to every component (legacy behavior).
// "degradation" rewrites the per-component degradation trajectory (battery
// and tires) to the requested preset. Replies are JSON {vin, running,
// published, messageType, components, ground_truth} on the request's reply
// subject, or {"error": ...}.
func (c *controlState) handle(msg *nats.Msg) {
	var req struct {
		Action    string `json:"action"`
		Component string `json:"component"`
		Preset    string `json:"preset"`
		Vin       string `json:"vin"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		c.reply(msg, map[string]any{"error": "invalid JSON"})
		return
	}
	c.mu.Lock()
	switch req.Action {
	case "degradation":
		c.mu.Unlock()
		c.applyDegradation(msg, req.Component, req.Preset)
		return
	case "speed":
		var mult float64
		if req.Preset != "" {
			if n, err := strconv.ParseFloat(req.Preset, 64); err == nil && n >= 1 {
				mult = n
			}
		}
		if mult == 0 {
			c.mu.Unlock()
			c.reply(msg, map[string]any{"error": "invalid multiplier"})
			return
		}
		c.speed = mult
	case "reset":
		c.mu.Unlock()
		c.resetSimulation(msg)
		return
	case "start", "stop":
		// Runtime VIN switching: a start request for a DIFFERENT pool VIN
		// makes the simulator adopt that VIN before enabling components — so
		// selecting VIN1002 + Start actually runs a fresh VIN1002 (identity,
		// degradation curves and subjects all repoint to it). adopt resets
		// the drive/battery state exactly like a reset, so the new VIN
		// starts clean.
		if req.Action == "start" && req.Vin != "" && req.Vin != c.vin {
			c.mu.Unlock()
			if err := c.adopt(req.Vin); err != nil {
				c.reply(msg, map[string]any{"error": err.Error()})
				return
			}
			c.mu.Lock()
		}
		if req.Component == "" {
			for _, comp := range c.components {
				comp.enabled = req.Action == "start"
			}
			if req.Action == "start" {
				c.startedAt = time.Now()
			}
		} else {
			comp, ok := c.components[req.Component]
			if !ok {
				c.mu.Unlock()
				c.reply(msg, map[string]any{"error": "unknown component " + req.Component})
				return
			}
			comp.enabled = req.Action == "start"
			if comp.enabled && !c.running {
				c.startedAt = time.Now()
			}
		}
		c.running = c.anyEnabledLocked()
	case "status":
	default:
		c.mu.Unlock()
		c.reply(msg, map[string]any{"error": "unknown action"})
		return
	}
	state := c.stateLocked()
	c.mu.Unlock()
	c.reply(msg, state)
}

func (c *controlState) anyEnabledLocked() bool {
	for _, comp := range c.components {
		if comp.enabled {
			return true
		}
	}
	return false
}

// adopt switches the simulator to another pool VIN at runtime (the web's
// "select VIN + Start" drives this). Under the lock it swaps the active VIN,
// reseeds every degradation config from the new VIN's fleet preset, clears
// the ground-truth/live/route state and re-arms the publish loop's drive and
// battery state via resetFn — so a fresh VIN starts clean (age 0, healthy
// curves, zeroed brake accumulator) exactly like a reset. Publish subjects
// read the active VIN dynamically (v.VIN), so they repoint automatically.
func (c *controlState) adopt(vin string) error {
	if vin == "" {
		return fmt.Errorf("adopt: empty vin")
	}
	c.mu.Lock()
	c.vin = vin
	for _, deg := range c.degradation {
		deg.HorizonDays = defaultDegradationConfig(deg.Component, poolIndex(vin)).HorizonDays
	}
	c.published = 0
	c.startedAt = time.Now()
	c.groundTruth = map[string]map[string]any{}
	c.routeDist = 0
	c.live = map[string]any{}
	reset := c.resetFn
	c.mu.Unlock()
	if reset != nil {
		reset()
	}
	return nil
}

// resetSimulation handles {"action":"reset"}: restore the vehicle to its
// demo starting state — battery age 0, fresh drive cycle, zeroed brake
// accumulator — so a presenter can re-run the degradation story. Resets
// degradation horizons to the preset defaults but keeps the current speed
// multiplier. The reply carries the fresh state.
func (c *controlState) resetSimulation(msg *nats.Msg) {
	c.mu.Lock()
	c.published = 0
	c.startedAt = time.Now()
	c.groundTruth = map[string]map[string]any{}
	c.routeDist = 0
	c.live = map[string]any{}
	for _, deg := range c.degradation {
		deg.HorizonDays = defaultDegradationConfig(deg.Component, poolIndex(c.vin)).HorizonDays
	}
	// Re-init the publish loop's drive/battery state (called outside the
	// lock — it touches the sim's own state, not the control state).
	reset := c.resetFn
	state := c.stateLocked()
	c.mu.Unlock()
	if reset != nil {
		reset()
	}
	c.reply(msg, state)
}

// speedMultiplier returns the current demo-speed multiplier (1 = real-time).
func (c *controlState) speedMultiplier() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.speed < 1 {
		return 1
	}
	return c.speed
}

// applyDegradation handles {"action":"degradation","component":"<id>",
// "preset":"<preset>"}. The component may be a degradable component
// (battery|tires), "all", or empty (all). Preset must be healthy, degrading
// or critical; anything else is an error. Rewriting a trajectory keeps the
// existing horizon and resets nothing else — the trajectory is a function of
// the vehicle's age, so the change takes effect on the next tick.
func (c *controlState) applyDegradation(msg *nats.Msg, component, preset string) {
	switch preset {
	case "healthy", "degrading", "critical":
	default:
		c.reply(msg, map[string]any{"error": "unknown preset " + preset})
		return
	}
	c.mu.Lock()
	unknown := false
	if component == "" || component == "all" {
		for _, deg := range c.degradation {
			deg.Preset = preset
		}
	} else if deg, ok := c.degradation[component]; ok {
		deg.Preset = preset
	} else {
		unknown = true
	}
	state := c.stateLocked()
	c.mu.Unlock()
	if unknown {
		c.reply(msg, map[string]any{"error": "component " + component + " is not degradable"})
		return
	}
	c.reply(msg, state)
}

// componentOrder is the canonical dashboard order for the component
// registry. c.components is a map (random iteration order) — the status
// reply must be deterministic or the dashboard's groups reorder on every
// poll.
var componentOrder = []string{"battery", "cabin", "powertrain", "chassis"}

// stateLocked serializes the full control state incl. the component registry
// (id/label/enabled/sensors) so clients can discover telemetry dynamically.
// Components are emitted in componentOrder (any registry entries not in the
// list are appended sorted), keeping the reply stable across polls.
func (c *controlState) stateLocked() map[string]any {
	comps := make([]map[string]any, 0, len(c.components))
	emit := func(comp *componentState) {
		sensors := make([]map[string]any, 0, len(comp.sensors))
		for _, s := range comp.sensors {
			sensors = append(sensors, map[string]any{"name": s.Name, "label": s.Label, "unit": s.Unit})
		}
		comps = append(comps, map[string]any{
			"id":      comp.id,
			"label":   comp.label,
			"enabled": comp.enabled,
			"sensors": sensors,
		})
	}
	for _, id := range componentOrder {
		if comp, ok := c.components[id]; ok {
			emit(comp)
		}
	}
	var rest []string
	ordered := map[string]bool{}
	for _, id := range componentOrder {
		ordered[id] = true
	}
	for id := range c.components {
		if !ordered[id] {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	for _, id := range rest {
		if comp, ok := c.components[id]; ok {
			emit(comp)
		}
	}
	return map[string]any{
		"vin":               c.vin,
		"running":           c.running,
		"published":         c.published,
		"messageType":       c.messageType,
		"components":        comps,
		"ground_truth":      c.groundTruth,
		"speed":             c.speed,
		"degradation_accel": c.degradationAccel,
		"route": map[string]any{
			"total_m": int(simTrip.total),
			"lap":     c.lap(),
		},
		"live": c.live,
	}
}

// setLive stores the current drive-state values for the status reply. Called
// by the publish loop each tick. Map values are replaced wholesale — the
// /pm console polls the status reply for its KPI row.
func (c *controlState) setLive(vals map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.live = vals
}

// lap reports the current lap number (0-based from the route loop) and the
// fractional progress through it, computed from the drive state's travelled
// distance. The publish loop records the latest routeDist each tick.
// NOTE: called from stateLocked() while the caller already holds c.mu —
// must NOT lock.
func (c *controlState) lap() map[string]any {
	dist := c.routeDist
	total := simTrip.total
	if total <= 0 {
		return map[string]any{"number": 0, "progress": 0.0}
	}
	lap := int(dist / total)
	progress := (dist - float64(lap)*total) / total
	return map[string]any{"number": lap, "progress": math.Round(progress*1000) / 1000}
}

// isComponentEnabled reports whether a component is currently publishing.
func (c *controlState) isComponentEnabled(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	comp, ok := c.components[id]
	return ok && comp.enabled
}

// setGroundTruth stores the live simulator ground-truth values (battery
// wear/days-to-failure, brake wear fraction, tire pressure/temp) for the
// status reply. Called by the publish loop each tick; keys not present are
// left untouched so disabled components keep their last known values.
func (c *controlState) setGroundTruth(vals map[string]map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.groundTruth == nil {
		c.groundTruth = map[string]map[string]any{}
	}
	for k, v := range vals {
		c.groundTruth[k] = v
	}
}

// degradationFor returns a copy of the component's degradation config (nil
// when the component is not degradable). The publish loop reads it each tick
// so trajectory changes from the "degradation" control action take effect
// immediately.
func (c *controlState) degradationFor(id string) *DegradationConfig {
	c.mu.Lock()
	defer c.mu.Unlock()
	deg, ok := c.degradation[id]
	if !ok || deg == nil {
		return nil
	}
	cp := *deg
	return &cp
}

// isRunning reports whether publishing is currently enabled (any component).
func (c *controlState) isRunning() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.running
}

func (c *controlState) reply(msg *nats.Msg, body map[string]any) {
	c.replyFn(msg, body)
}

func main() {
	defaultRegistrationURL := os.Getenv("REGISTRATION_URL")

	vin := flag.String("vin", "", "Vehicle Identification Number (empty = random from VIN_POOL env)")
	pkiStrategy := flag.String("pki_strategy", "local", "PKI Strategy")
	factoryCert := flag.String("factory-cert", "", "Path to factory-issued certificate (required when registration is needed)")
	factoryKey := flag.String("factory-key", "", "Path to factory-issued private key (required when registration is needed)")
	registrationURL := flag.String("registration-url", defaultRegistrationURL, "Registration server URL (required when registration is needed)")
	keycloakURL := flag.String("keycloak-url", "", "Keycloak URL (used when reusing existing certificates)")
	natsURL := flag.String("nats-url", "", "NATS URL (used when reusing existing certificates)")
	interval := flag.Int("interval", 5, "Interval in seconds between telemetry messages")
	messageType := flag.String("message-type", "both", "Message type to send: 'telemetry' (TelemetryMessage), 'metrics_report' (MetricsReport), or 'both' (default: both per tick)")
	controlSubject := flag.String("control-subject", "", "NATS subject to listen for start/stop commands (empty = publish immediately)")
	// Path of the ground-truth labels JSONL file the simulator appends one
	// object per VIN per tick (see writeGroundTruthLabels). Empty = disabled.
	// Defaults to the GROUND_TRUTH_LABELS env so the compose service can mount
	// a writable volume without a flag change.
	groundTruthLabels := flag.String("ground-truth-labels", envOr("GROUND_TRUTH_LABELS", ""),
		"Path to append ground-truth labels JSONL (one object per VIN per tick); empty = disabled")
	flag.Parse()

	if *messageType != "telemetry" && *messageType != "metrics_report" && *messageType != "both" {
		log.Fatal("Message type must be 'telemetry', 'metrics_report', or 'both'")
	}

	mathrand.Seed(time.Now().UnixNano())

	// Random VIN selection when none given: pick from the pool env (set by the
	// local-dev simulator service / entrypoint) or fall back to a fixed VIN.
	vinPool := parseVINPool(os.Getenv("VIN_POOL"))
	if *vin == "" {
		*vin = randomVinFromPool(vinPool)
		log.Printf("Random VIN selected from pool: %s", *vin)
	}

	client := &VehicleClient{
		VIN:               *vin,
		pkiStrategy:       *pkiStrategy,
		MessageType:       *messageType,
		controlSubject:    *controlSubject,
		groundTruthLabels: *groundTruthLabels,
	}

	log.Printf("================================================")
	log.Printf("Starting vehicle client for VIN: %s", client.VIN)
	log.Printf("Message Type: %s", client.MessageType)
	log.Printf("================================================")
	log.Printf("Telemetry interval: %d seconds", *interval)

	var jwt string

	// Try to reuse existing certificates and token
	if existingJWT, ok := client.loadExistingCertsAndToken(); ok {
		log.Println("✓ Existing certificates and token are valid — skipping registration")
		if *keycloakURL == "" || *natsURL == "" {
			log.Fatal("-keycloak-url and -nats-url are required when reusing existing certificates")
		}
		client.keycloakURL = *keycloakURL
		client.natsURL = *natsURL
		jwt = existingJWT
	} else {
		// Full registration + auth flow
		log.Println("No valid existing certificates found — starting registration flow")
		if *factoryCert == "" || *factoryKey == "" {
			log.Fatal("-factory-cert and -factory-key are required for registration")
		}
		if *registrationURL == "" {
			log.Fatal("-registration-url is required for registration")
		}
		client.FactoryCertFile = *factoryCert
		client.FactoryKeyFile = *factoryKey
		client.RegistrationServerURL = *registrationURL

		if err := client.Register(); err != nil {
			log.Fatalf("Registration failed: %v", err)
		}
		log.Println("✓ Registered and obtained operational certificate")

		var err error
		jwt, _, err = client.AuthenticateWithKeycloak()
		if err != nil {
			log.Fatalf("Keycloak authentication failed: %v", err)
		}
		log.Println("✓ Authenticated with Keycloak")
	}

	// Smoke test NATS connectivity
	log.Println("Smoke testing NATS connectivity...")
	if err := client.ConnectToNATS(jwt); err != nil {
		log.Fatalf("NATS smoke test failed: %v", err)
	}
	log.Println("✓ NATS smoke test passed")

	log.Println("Starting continuous telemetry publishing...")
	if err := client.PublishTelemetryContinuously(*interval); err != nil {
		log.Fatalf("Failed to publish telemetry: %v", err)
	}
}

// loadExistingCertsAndToken checks whether a valid operational certificate and
// unexpired JWT token already exist on disk. If both are valid it loads them
// into the client and returns (token, true); otherwise it returns ("", false).
func (v *VehicleClient) loadExistingCertsAndToken() (string, bool) {
	certPEM, err := os.ReadFile("certificates/operational-cert.pem")
	if err != nil {
		log.Printf("No existing operational certificate: %v", err)
		return "", false
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		log.Println("Could not decode existing operational certificate PEM")
		return "", false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		log.Printf("Could not parse existing operational certificate: %v", err)
		return "", false
	}
	if time.Until(cert.NotAfter) < 60*time.Second {
		log.Printf("Operational certificate expired at %s", cert.NotAfter.Format(time.RFC3339))
		return "", false
	}

	keyPEM, err := os.ReadFile("certificates/operational-key.pem")
	if err != nil {
		log.Printf("No existing operational key: %v", err)
		return "", false
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		log.Println("Could not decode existing operational key PEM")
		return "", false
	}
	key, err := x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
	if err != nil {
		log.Printf("Could not parse existing operational key: %v", err)
		return "", false
	}

	tokenBytes, err := os.ReadFile("certificates/oidc-access-token")
	if err != nil {
		log.Printf("No existing access token: %v", err)
		return "", false
	}
	token := strings.TrimSpace(string(tokenBytes))
	expiry := jwtExpiry(token)
	if time.Until(expiry) < 60*time.Second {
		log.Printf("Access token expired at %s", expiry.Format(time.RFC3339))
		return "", false
	}

	v.operationalCert = cert
	v.operationalCertPEM = certPEM
	v.operationalKey = key
	log.Printf("  Certificate valid until: %s", cert.NotAfter.Format(time.RFC3339))
	log.Printf("  Token valid until:       %s", expiry.Format(time.RFC3339))
	return token, true
}

// jwtExpiry decodes the exp claim from a JWT without verifying the signature.
func jwtExpiry(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}
	}
	var claims map[string]interface{}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}
	}
	exp, ok := claims["exp"].(float64)
	if !ok {
		return time.Time{}
	}
	return time.Unix(int64(exp), 0)
}

// envOr returns the value of environment variable key, or def when it is unset
// or empty. Used to let local-dev override GCP-default Keycloak identity values
// without changing production behaviour (empty env => original default).
func envOr(key, def string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return def
}

// Register performs the vehicle registration flow
func (v *VehicleClient) Register() error {
	log.Printf("************************************************")
	log.Println(" Starting client registration")
	log.Printf("************************************************")
	log.Println("Retrieving operational certificate...")

	// Generate a new RSA key pair for operational use
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("failed to generate key pair: %w", err)
	}
	v.operationalKey = privateKey

	// Create a Certificate Signing Request (CSR)
	log.Println("Creating Certificate Signing Request (CSR)...")
	csrPEM, err := v.createCSR(privateKey)
	if err != nil {
		return fmt.Errorf("failed to create CSR: %w", err)
	}

	// Load factory certificate and key for mTLS
	log.Println("Loading factory-issued certificate for mTLS...")
	factoryCert, err := tls.LoadX509KeyPair(v.FactoryCertFile, v.FactoryKeyFile)
	if err != nil {
		return fmt.Errorf("failed to load factory certificate: %w", err)
	}

	// Load CA certificate for the registration server
	regServerCA, err := os.ReadFile("certificates/REGISTRATION_SERVER_TLS_CERT.pem")
	if err != nil {
		return fmt.Errorf("failed to load registration server CA: %w", err)
	}
	caCertPool := x509.NewCertPool()
	caCertPool.AppendCertsFromPEM(regServerCA)

	// Configure mTLS client
	tlsConfig := &tls.Config{
		Certificates:       []tls.Certificate{factoryCert},
		InsecureSkipVerify: v.pkiStrategy == "local", // Verify the server certificate
		RootCAs:            caCertPool,
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS13,
		// Use classic key exchange curves to avoid post-quantum compatibility issues
		// between Go's crypto/tls and rustls's X25519MLKEM768 implementation
		CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384},
		// Force client certificate to be sent
		GetClientCertificate: func(info *tls.CertificateRequestInfo) (*tls.Certificate, error) {
			log.Println("  Server requested client certificate")
			return &factoryCert, nil
		},
	}

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
		Timeout: 30 * time.Second,
	}

	// Send CSR to registration server
	log.Printf("Sending CSR to registration server at %s...", v.RegistrationServerURL)
	req, err := http.NewRequest("POST", v.RegistrationServerURL+"/registration", bytes.NewReader(csrPEM))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-pem-file")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("registration failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Parse the registration response
	var regResp RegistrationResponse
	if err := json.NewDecoder(resp.Body).Decode(&regResp); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	log.Println("Parsing operational certificate...")
	// Parse the operational certificate
	block, _ := pem.Decode([]byte(regResp.Certificate))
	if block == nil {
		return fmt.Errorf("failed to parse certificate PEM")
	}

	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("failed to parse certificate: %w", err)
	}

	v.operationalCert = cert
	v.operationalCertPEM = []byte(regResp.Certificate)
	v.keycloakURL = regResp.KeycloakURL
	v.natsURL = regResp.NatsURL

	// The registration server echoes host-reachable URLs (REG_CLIENT_*),
	// which is right for host-run clients but wrong in-container. Env
	// overrides win on the fresh path too (the local-dev simulator service
	// sets these to the in-network hostnames).
	if u := os.Getenv("KEYCLOAK_URL"); u != "" {
		v.keycloakURL = u
	}
	if u := os.Getenv("NATS_URL"); u != "" {
		v.natsURL = u
	}

	log.Printf("  Keycloak URL: %s", v.keycloakURL)
	log.Printf("  NATS URL: %s", v.natsURL)
	log.Printf("  Certificate valid until: %s", cert.NotAfter)

	certDir := "certificates/"
	// Save operational certificate and key to files for reuse
	if err := os.WriteFile(certDir+"operational-cert.pem", v.operationalCertPEM, 0644); err != nil {
		log.Printf("Warning: Failed to save operational certificate: %v", err)
	} else {
		log.Println("  Saved operational certificate to operational-cert.pem")
	}

	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(v.operationalKey),
	})
	if err := os.WriteFile(certDir+"operational-key.pem", keyPEM, 0600); err != nil {
		log.Printf("Warning: Failed to save operational key: %v", err)
	} else {
		log.Println("  Saved operational key to operational-key.pem")
	}

	return nil
}

// createCSR generates a Certificate Signing Request
func (v *VehicleClient) createCSR(privateKey *rsa.PrivateKey) ([]byte, error) {
	// Create CSR with VIN and DEVICE in the expected format
	// The registration server expects CN in format: "VIN:xxx DEVICE:yyy"
	cn := fmt.Sprintf("VIN:%s DEVICE:%s", v.VIN, v.VIN)

	// Encode CN as UTF8String (required by registration server)
	// Use the string bytes directly, not asn1.Marshal which would double-encode
	subject := pkix.Name{
		Organization: []string{"Vehicle Manufacturer"},
		ExtraNames: []pkix.AttributeTypeAndValue{
			{
				Type: asn1.ObjectIdentifier{2, 5, 4, 3}, // CN OID
				Value: asn1.RawValue{
					Tag:   asn1.TagUTF8String,
					Bytes: []byte(cn),
				},
			},
		},
	}

	template := x509.CertificateRequest{
		Subject:            subject,
		SignatureAlgorithm: x509.SHA256WithRSA,
	}

	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &template, privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create certificate request: %w", err)
	}

	// Encode to PEM
	csrPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE REQUEST",
		Bytes: csrDER,
	})

	return csrPEM, nil
}

// AuthenticateWithKeycloak obtains a JWT token using the operational certificate
func (v *VehicleClient) AuthenticateWithKeycloak() (string, int, error) {
	log.Println("Authenticate With Keycloak Step 1: Configuring mTLS with operational certificate...")

	// Create TLS certificate from operational cert and key
	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(v.operationalKey),
	})

	cert, err := tls.X509KeyPair(v.operationalCertPEM, keyPEM)
	if err != nil {
		return "", 0, fmt.Errorf("failed to create X509 key pair: %w", err)
	}

	// Load CA certificate for the Keycloak server
	keycloakCA, err := os.ReadFile("certificates/KEYCLOAK_TLS_CRT.pem")
	if err != nil {
		return "", 0, fmt.Errorf("failed to load Keycloak CA: %w", err)
	}
	caCertPool := x509.NewCertPool()
	caCertPool.AppendCertsFromPEM(keycloakCA)

	// Configure mTLS client
	tlsConfig := &tls.Config{
		Certificates:       []tls.Certificate{cert},
		InsecureSkipVerify: false, // Verify the server certificate
		RootCAs:            caCertPool,
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS13,
		// Use classic key exchange curves to avoid post-quantum compatibility issues
		CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384},
		// Force client certificate to be sent
		GetClientCertificate: func(info *tls.CertificateRequestInfo) (*tls.Certificate, error) {
			log.Println("  Keycloak requested client certificate")
			return &cert, nil
		},
	}

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
		Timeout: 30 * time.Second,
	}

	// Request JWT token from Keycloak
	log.Printf("Authenticate With Keycloak Step 2: Requesting JWT from Keycloak at %s...", v.keycloakURL)

	// Realm and client_id default to the GCP deployment's values so production
	// behaviour is unchanged; local-dev overrides them via env (see
	// local-dev/scripts/run-vehicle-client.sh) because its imported realm is
	// "nexus-sdv" with a client-secret "vehicle-client" service-account client,
	// not the GCP mTLS "car" client in realm "sdv-telemetry".
	realm := envOr("KEYCLOAK_REALM", "sdv-telemetry")
	clientID := envOr("KEYCLOAK_CLIENT_ID", "car")
	tokenURL := fmt.Sprintf("%s/realms/%s/protocol/openid-connect/token", v.keycloakURL, realm)

	// For client certificate authentication, we use grant_type=client_credentials.
	// The client_id should match the clientId configured in Keycloak.
	// Request openid scope to get an ID token, and offline_access for a refresh token.
	data := fmt.Sprintf("grant_type=client_credentials&client_id=%s&scope=openid+offline_access", url.QueryEscape(clientID))

	// When a client secret is supplied (a confidential client, e.g. local-dev's
	// "vehicle-client"), authenticate with it. When empty (GCP's mTLS "car"
	// client), the operational client certificate configured above is the sole
	// credential and no secret is sent - preserving the original behaviour.
	if secret := os.Getenv("KEYCLOAK_CLIENT_SECRET"); secret != "" {
		data += "&client_secret=" + url.QueryEscape(secret)
	}

	req, err := http.NewRequest("POST", tokenURL, bytes.NewBufferString(data))
	if err != nil {
		return "", 0, fmt.Errorf("failed to create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("failed to request token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", 0, fmt.Errorf("token request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp KeycloakTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", 0, fmt.Errorf("failed to decode token response: %w", err)
	}

	log.Printf("  Token expires in: %d seconds", tokenResp.ExpiresIn)

	// Write the full token response as JSON to disk
	tokenJSON, err := json.MarshalIndent(tokenResp, "", "  ")
	if err != nil {
		log.Printf("  Warning: failed to marshal token response: %v", err)
	} else {
		if err := os.WriteFile("certificates/oidc-token.json", tokenJSON, 0600); err != nil {
			log.Printf("  Warning: failed to write OIDC token JSON to disk: %v", err)
		} else {
			log.Println("  OIDC token response written to certificates/oidc-token.json")
		}
	}

	// Write individual tokens to separate files for easy consumption
	tokenFiles := map[string]string{
		"certificates/oidc-access-token":  tokenResp.AccessToken,
		"certificates/oidc-id-token":      tokenResp.IDToken,
		"certificates/oidc-refresh-token": tokenResp.RefreshToken,
	}
	for path, token := range tokenFiles {
		if token == "" {
			continue
		}
		if err := os.WriteFile(path, []byte(token), 0600); err != nil {
			log.Printf("  Warning: failed to write %s: %v", path, err)
		} else {
			log.Printf("  Token written to %s", path)
		}
	}

	return tokenResp.AccessToken, tokenResp.ExpiresIn, nil
}

// ConnectToNATS establishes a connection to NATS using the JWT
func (v *VehicleClient) ConnectToNATS(jwt string) error {
	log.Printf("[Smoke test] Connecting to NATS at %s with JWT...", v.natsURL)

	// Connect to NATS with JWT authentication
	// Use nats.Token() to pass the Keycloak JWT for auth-callout validation
	nc, err := nats.Connect(v.natsURL,
		nats.Token(jwt),
		nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
			log.Printf("NATS error: %v", err)
		}),
	)
	if err != nil {
		return fmt.Errorf("failed to connect to NATS: %w", err)
	}
	defer nc.Close()

	log.Println("  [Smoke test] Connected to NATS successfully")

	// Wait a moment to ensure connection is stable
	time.Sleep(1 * time.Second)

	return nil
}

// buildTelemetrySubject constructs the NATS subject for generic TelemetryMessage publishing
// Supports configurable prefix via TELEMETRY_PREFIX environment variable
// Examples:
//   - Without prefix: telemetry-generic.{VIN}.{sensor}
//   - With prefix "prod.bigtable": telemetry-generic.prod.bigtable.{VIN}.{sensor}
func (v *VehicleClient) buildTelemetrySubject(sensor string) string {
	prefix := os.Getenv("TELEMETRY_PREFIX")
	if prefix != "" {
		return fmt.Sprintf("telemetry-generic.%s.%s.%s", prefix, v.VIN, sensor)
	}
	return fmt.Sprintf("telemetry-generic.%s.%s", v.VIN, sensor)
}

// buildMetricsReportSubject constructs the NATS subject for MetricsReport publishing
// Format: telemetry.{VIN}
func (v *VehicleClient) buildMetricsReportSubject() string {
	return fmt.Sprintf("telemetry.%s", v.VIN)
}

// PublishTelemetry sends sample telemetry data to NATS
func (v *VehicleClient) PublishTelemetry() error {
	log.Println("Publishing telemetry data...")

	// For telemetry publishing, we need a fresh NATS connection
	jwt, _, err := v.AuthenticateWithKeycloak()
	if err != nil {
		return fmt.Errorf("failed to get JWT for telemetry: %w", err)
	}

	nc, err := nats.Connect(v.natsURL,
		nats.Token(jwt),
	)
	if err != nil {
		return fmt.Errorf("failed to connect to NATS: %w", err)
	}
	defer nc.Close()

	// Publish sample telemetry
	subject := v.buildTelemetrySubject("battery")
	data := map[string]interface{}{
		"vin":             v.VIN,
		"timestamp":       time.Now().Unix(),
		"battery_voltage": 12.6,
		"battery_current": 45.2,
		"battery_soc":     85.5,
		"battery_temp":    25.3,
	}

	payload, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("failed to marshal telemetry: %w", err)
	}

	if err := nc.Publish(subject, payload); err != nil {
		return fmt.Errorf("failed to publish telemetry: %w", err)
	}

	log.Printf("  Published telemetry to subject: %s", subject)
	log.Printf("  Payload: %s", string(payload))

	// Flush to ensure message is sent
	if err := nc.Flush(); err != nil {
		return fmt.Errorf("failed to flush NATS connection: %w", err)
	}

	return nil
}

// PublishTelemetryContinuously sends telemetry data to NATS continuously
// Supports three message types: "telemetry" (TelemetryMessage), "metrics_report" (MetricsReport), and "both" (one of each per tick)
func (v *VehicleClient) PublishTelemetryContinuously(intervalSeconds int) error {
	// Control state for start/stop/status when a control subject is configured.
	// Declared before the payload state so the battery's degradation
	// trajectory can be seeded from the per-VIN defaults.
	ctl := newControlState(v.VIN, v.MessageType)

	// Initial battery state. The degradation trajectory comes from the
	// control state (default preset per DEGRADATION_PRESET); ageDays starts
	// at 0 and accrues real-time (intervalSeconds per tick — a 2 s tick
	// advances simulated age by 2 s, so 1 sim day per 24 h wall time).
	battery := batteryState{
		voltage: 12.6,
		current: 45.2,
		soc:     85.5,
		temp:    25.3,
		deg:     ctl.degradationFor("battery"),
	}

	// Randomized drive cycle state (velocity, engine, GPS, dynamics)
	drive := newDriveState()

	// Reset flag set by the "reset" control action (via ctl.resetFn); the
	// publish loop consumes it on its next tick (same goroutine, race-free).
	var resetRequested int32

	// Reset hook for the "reset" control action: restore the demo to its
	// starting state (battery age 0, fresh drive cycle, zeroed brake
	// accumulator) so a presenter can re-run the degradation story. The
	// actual re-init happens in publishOnce (same goroutine as the state it
	// mutates) — the handler only sets the flag.
	ctl.resetFn = func() {
		atomic.StoreInt32(&resetRequested, 1)
	}

	// JWT refresh parameters
	var nc *nats.Conn
	var jwtExpiry time.Time
	refreshBuffer := 60 * time.Second // Refresh JWT 60 seconds before expiry

	// controlSub tracks the live control subscription. NATS subscriptions are
	// bound to a connection: refreshConnection() closes and re-dials, which
	// silently kills the old subscription. ensureControlSub must therefore run
	// after every successful refresh so start/stop/status keep working.
	var controlSub *nats.Subscription
	ensureControlSub := func() error {
		if v.controlSubject == "" {
			return nil
		}
		if controlSub != nil {
			_ = controlSub.Unsubscribe() // stale: bound to the closed connection
		}
		// Wildcard subscription: the web targets start/stop/status at
		// commands.<selectedVIN>.demo, and the simulator adopts whichever
		// pool VIN a start request names (see controlState.adopt) — so it
		// must hear commands for every pool VIN, not just the boot VIN.
		// NATS '>' must be the FINAL token (commands.> would be an
		// invalid subject and the connection would close), so subscribe to
		// commands.> which matches commands.<VIN>.demo. DEMO_MODE=true on
		// auth-callout grants commands.> for this.
		sub, err := nc.Subscribe("commands.>", func(msg *nats.Msg) {
			ctl.handle(msg)
		})
		if err != nil {
			return fmt.Errorf("failed to subscribe to control subject: %w", err)
		}
		controlSub = sub
		return nil
	}

	// Helper function to get fresh connection
	refreshConnection := func() error {
		if nc != nil {
			nc.Close()
		}

		log.Println("Establishing telemetry NATS connection (re-authenticating with Keycloak)...")
		jwt, expiresIn, err := v.AuthenticateWithKeycloak()
		if err != nil {
			return fmt.Errorf("failed to get JWT: %w", err)
		}

		// Use the REAL token lifetime from Keycloak (expires_in). The old
		// hardcoded 2 weeks made the refresh loop sleep past the actual
		// 5-minute token, so the connection died with 'authentication
		// expired' and never recovered. Refresh well before expiry.
		if expiresIn <= 0 {
			expiresIn = 300 // sane default if the realm omits it
		}
		refreshBuffer = time.Duration(expiresIn/10) * time.Second
		if refreshBuffer < 30*time.Second {
			refreshBuffer = 30 * time.Second
		}
		jwtExpiry = time.Now().Add(time.Duration(expiresIn) * time.Second)
		log.Printf("JWT refreshed, expires in %ds (refresh buffer %s)", expiresIn, refreshBuffer)

		nc, err = nats.Connect(v.natsURL,
			nats.Token(jwt),
			nats.ClosedHandler(func(nc *nats.Conn) {
				log.Printf("NATS connection closed (reason: %v)", nc.LastError())
			}),
		)
		if err != nil {
			return fmt.Errorf("failed to connect to NATS: %w", err)
		}
		log.Println("  Telemetry NATS connection established")

		// A fresh connection carries no subscriptions. Re-establish the
		// control subscription here so it survives every refresh path: the
		// initial connect, publishOnce's JWT refresh, the publish-error
		// reconnect, and the idle-loop refresh. Subscribing outside the
		// control-mode branch also keeps non-control mode a no-op.
		return ensureControlSub()
	}

	// Initial connection
	log.Println("Establishing initial telemetry NATS connection...")
	if err := refreshConnection(); err != nil {
		return err
	}
	defer nc.Close()

	ticker := time.NewTicker(time.Duration(intervalSeconds) * time.Second)
	defer ticker.Stop()

	messageCount := 0

	// publishOnce performs one full simulation tick: refresh the JWT when
	// needed, advance battery + drive state, build the payload(s) for the
	// configured message type, publish each, and track the published count.
	publishOnce := func() {
		// Consume a pending reset: re-init battery + drive state so the
		// demo restarts from its known healthy starting point.
		if atomic.CompareAndSwapInt32(&resetRequested, 1, 0) {
			battery = batteryState{
				voltage: 12.6,
				current: 45.2,
				soc:     85.5,
				temp:    25.3,
				deg:     ctl.degradationFor("battery"),
				ageDays: 0,
			}
			drive = newDriveState()
		}

		// Check if JWT needs refresh
		if time.Until(jwtExpiry) < refreshBuffer {
			log.Println("JWT expiring soon, refreshing connection...")
			if err := refreshConnection(); err != nil {
				log.Printf("Failed to refresh connection: %v", err)
				return
			}
		}

		// Simulate battery degradation: age the vehicle, then walk the
		// physics-informed trajectory (V_rest curve, R_int, V_min) with a
		// small noise term instead of the old random walk. The degradation
		// config can be rewritten by the "degradation" control action, so
		// re-read it each tick.
		if deg := ctl.degradationFor("battery"); deg != nil {
			battery.deg = deg
		}
		speed := ctl.speedMultiplier()
		battery.ageDays += float64(intervalSeconds) / 86400.0 * speed * ctl.degradationAccel
		vRest, vMin, rInt := battery.deg.BatteryAt(battery.ageDays)
		// Realistic per-signal Gaussian noise: a resting voltage sensor reads
		// ±10 mV std (thermal + ADC), SOC ±0.5%, temp ±0.3 °C. The PM
		// detector's EWMA (alpha 0.1) then sees a clean physical trend under
		// plausible sensor scatter instead of uniform jitter.
		battery.voltage = vRest + gauss(0.010)
		battery.soc = clamp(85.5-30*((battery.deg.severityFactor()*battery.ageDays/120.0)/1.0)+gauss(0.5), 5, 100)
		battery.temp = battery.deg.BatteryTempAt(battery.ageDays) + gauss(0.3)
		_ = vMin
		_ = rInt
		battery.voltage = clamp(battery.voltage, 11.0, 14.5)
		battery.current = clamp(battery.current+gauss(0.4), 0, 100)

		// Advance the randomized drive cycle (velocity, engine, GPS, dynamics).
		driveCycleStep(&drive, float64(intervalSeconds), speed)
		ctl.mu.Lock()
		ctl.routeDist = drive.tripDist
		ctl.mu.Unlock()

		// Mirror the live degradation state onto the client so the chassis
		// report and ground truth use the same config the battery walks
		// (control actions rewrite ctl.degradation; pick it up each tick).
		// The active VIN too — adopt() swaps ctl.vin at runtime, and publish
		// subjects read v.VIN, so the client mirrors it before each tick's
		// payloads are built (subjects then repoint to the adopted VIN).
		v.VIN = ctl.vin
		v.batteryAgeDays = battery.ageDays
		v.tiresDeg = ctl.degradationFor("tires")

		// Ground truth for the status reply: wear fractions and days to
		// failure per degradable component, derived from the same curves the
		// published telemetry walks (so detector-vs-truth stays comparable).
		now := time.Now()
		ctl.setGroundTruth(v.groundTruth(battery, drive))
		tireBar := 2.2
		if v.tiresDeg != nil {
			tireBar = v.tiresDeg.TirePressureAt("FL", v.batteryAgeDays)
		}
		ctl.setLive(map[string]any{
			"velocity_m_s":      math.Round(drive.velocity*10) / 10,
			"tire_pressure_bar": math.Round(tireBar*100) / 100,
			"lat":               drive.lat,
			"lng":               drive.lng,
			"battery_voltage":   math.Round(battery.voltage*100) / 100,
			"heading_deg":       math.Round(drive.headingDeg),
		})

		// Offline evaluator labels: one JSONL object per VIN per tick (no-op
		// when no GROUND_TRUTH_LABELS path is configured).
		v.writeGroundTruthLabels(now, battery, drive)

		// Build the payload(s) for this tick based on the configured message
		// type and publish each one. Control mode gates per component; free-run
		// mode (no control subject) publishes every component — legacy
		// behavior.
		enabled := ctl.isComponentEnabled
		if v.controlSubject == "" {
			enabled = func(string) bool { return true }
		}
		for _, m := range v.buildPayloads(now, battery, drive, v.MessageType, messageCount, enabled) {
			// Publish to NATS
			if err := nc.Publish(m.subject, m.payload); err != nil {
				log.Printf("Failed to publish: %v", err)
				// Try to reconnect on publish error
				if err := refreshConnection(); err != nil {
					log.Printf("Failed to reconnect: %v", err)
				}
				continue
			}

			messageCount++
			ctl.mu.Lock()
			ctl.published++
			ctl.mu.Unlock()
			if m.kind == "telemetry" {
				log.Printf("[%d] Published TelemetryMessage to %s: SoC=%.1f%%, Voltage=%.2fV, Current=%.2fA, Temp=%.1f°C",
					messageCount, m.subject, battery.soc, battery.voltage, battery.current, battery.temp)
			} else {
				log.Printf("[%d] Published MetricsReport to %s: Power=%.1fW, RPM=%.0f, Speed=%.1fkm/h, Fuel=%.1f%%",
					messageCount, m.subject, drive.enginePower, drive.engineRPM, drive.velocity, drive.fuelLevel)
			}
		}
	}

	// ---- History backfill -------------------------------------------------
	// A fresh stack has no telemetry history, so the detector (which needs a
	// 30-day trend window) would stay silent for days. Backfill simulated
	// history so PM alerts fire within a minute of startup: advance the
	// battery's age by one simulated day per row and publish a battery + tire
	// sample, so Bigtable gets ~BACKFILL_DAYS daily rows and the detector's
	// 30-day window + slope fire immediately. (The drive cycle is NOT stepped
	// at day-scale — velocity math would explode; the brake/tire ground truth
	// accrues live.)
	backfillDays := 30
	if b := os.Getenv("BACKFILL_DAYS"); b != "" {
		if n, err := strconv.Atoi(b); err == nil && n >= 0 {
			backfillDays = n
		}
	}
	if backfillDays > 0 {
		log.Printf("Backfilling %d days of telemetry history per VIN...", backfillDays)
		for i := 0; i < backfillDays; i++ {
			// Re-read the degradation config (control actions may change it),
			// advance one simulated day, and emit a battery + tire sample.
			if deg := ctl.degradationFor("battery"); deg != nil {
				battery.deg = deg
			}
			battery.ageDays += 1.0 // one simulated day per backfill row
			vRest, _, _ := battery.deg.BatteryAt(battery.ageDays)
			battery.voltage = clamp(vRest+(mathrand.Float64()-0.5)*0.025, 11.0, 14.5)
			battery.soc = clamp(85.5-30*(battery.deg.severityFactor()*battery.ageDays/120.0), 5, 100)
			battery.temp = battery.deg.BatteryTempAt(battery.ageDays)

			now := time.Now().Add(-time.Duration(backfillDays-i) * 24 * time.Hour)
			// Free-run: backfill history for every component regardless of
			// control gating (a fresh stack should have battery/tire history).
			for _, m := range v.buildPayloads(now, battery, drive, v.MessageType, messageCount, func(string) bool { return true }) {
				if m.kind != "telemetry" {
					continue // battery/tire rows live on the TelemetryMessage path
				}
				if err := nc.Publish(m.subject, m.payload); err != nil {
					log.Printf("Backfill publish failed: %v", err)
					continue
				}
				messageCount++
			}
		}
		log.Println("History backfill complete — entering live loop")
	}

	// Control loop: wait for start/stop over NATS when a control subject is
	// given; otherwise behave exactly as before (start publishing immediately).
	if v.controlSubject != "" {
		defer func() {
			if controlSub != nil {
				_ = controlSub.Unsubscribe()
			}
		}()
		log.Printf("Awaiting start command on commands.>")
		for range ticker.C {
			if ctl.isRunning() {
				publishOnce() // one tick while running
			}
			// A dropped connection (e.g. the server closed it during
			// backfill) leaves the control subscription dead: NATS subs are
			// bound to the connection, so start/stop/status would 503 until
			// the JWT refresh timer fires. Reconnect immediately when the
			// connection is closed so control commands keep working.
			if nc.IsClosed() {
				log.Println("Connection closed — reconnecting to restore control subscription")
				if err := refreshConnection(); err != nil {
					log.Printf("Failed to reconnect: %v", err)
				}
			} else if time.Until(jwtExpiry) < refreshBuffer {
				if err := refreshConnection(); err != nil { // keep JWT fresh while idle too
					log.Printf("Failed to refresh connection: %v", err)
				}
			}
		}
		return nil
	}
	for range ticker.C {
		publishOnce()
	}

	return nil
}
