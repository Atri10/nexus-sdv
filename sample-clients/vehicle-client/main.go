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
	mathrand "math/rand"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
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
	tripDist       float64 // metres travelled along the trip route
	lat            float64
	lng            float64
	headingDeg     float64 // degrees clockwise from north (road direction)
}

type batteryState struct {
	voltage float64
	current float64
	soc     float64
	temp    float64
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

func newDriveState() driveState {
	lat, lng, heading := simTrip.positionAt(0)
	return driveState{
		fuelLevel:     20 + mathrand.Float64()*60,
		phase:         0,
		phaseLeft:     5 + mathrand.Float64()*10,
		tripDist:      0,
		lat:           lat,
		lng:           lng,
		headingDeg:    heading,
		steeringAngle: (mathrand.Float64() - 0.5) * 4,
	}
}

// driveCycleStep advances the drive profile by dt seconds. Velocity follows a
// smooth accelerate/cruise/brake/idle cycle; derived sensors correlate.
func driveCycleStep(s *driveState, dt float64) {
	s.phaseLeft -= dt
	if s.phaseLeft <= 0 {
		s.phase = (s.phase + 1) % 4
		switch s.phase {
		case 0:
			s.phaseLeft = 6 + mathrand.Float64()*12 // accelerate
		case 1:
			s.phaseLeft = 8 + mathrand.Float64()*15 // cruise
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
	case 2: // brake
		s.velocity -= 3.0 * dt
		s.acceleratorPct = 0
		s.brakePct = clamp(20+mathrand.Float64()*40, 0, 100)
	case 3: // idle
		s.velocity -= 0.5 * dt
		s.acceleratorPct = 0
		s.brakePct = 0
	}
	s.velocity = clamp(s.velocity, 0, 200)
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

	// Advance along the real trip route: distance = velocity * dt, position
	// interpolated on the embedded street loop, heading following the road.
	s.tripDist += s.velocity * dt
	s.lat, s.lng, s.headingDeg = simTrip.positionAt(s.tripDist)
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
// fields (velocity, tire pressure, GPS, steering/pedals, ignition).
func buildChassisReport(vin string, drive driveState, now time.Time) (*pbMetrics.MetricsReport, error) {
	ignitionState := drive.engineRPM > 0
	gpsLat := float32(drive.lat)
	gpsLon := float32(drive.lng)
	tirePressure := 2.2 + (mathrand.Float64()-0.5)*0.1

	vehicleData := &pbVehicle.VehicleTelemetryData{
		VELOCITY:      f32(float32(drive.velocity)),
		TIRE_PRESSURE: f32(float32(tirePressure)),
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
			if report, err := buildChassisReport(v.VIN, drive, now); err == nil {
				if payload, err := proto.Marshal(report); err == nil {
					emit("metrics_report", v.buildMetricsReportSubject(), payload)
				}
			}
		}
	}
	return out
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
}

// newControlState builds the component registry. This is the single source
// of truth for what the simulator can stream; keep in sync with the payload
// builders in buildPayloads.
func newControlState(vin, messageType string) *controlState {
	return &controlState{
		vin:         vin,
		messageType: messageType,
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
// {"action":"start"|"stop"|"status","component":"<id>"}. The component
// field is optional — without it start/stop apply to every component
// (legacy behavior). Replies are JSON {vin, running, published, messageType,
// components} on the request's reply subject, or {"error": ...}.
func (c *controlState) handle(msg *nats.Msg) {
	var req struct {
		Action    string `json:"action"`
		Component string `json:"component"`
	}
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		c.reply(msg, map[string]any{"error": "invalid JSON"})
		return
	}
	c.mu.Lock()
	switch req.Action {
	case "start", "stop":
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

// stateLocked serializes the full control state incl. the component registry
// (id/label/enabled/sensors) so clients can discover telemetry dynamically.
func (c *controlState) stateLocked() map[string]any {
	comps := make([]map[string]any, 0, len(c.components))
	for _, comp := range c.components {
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
	return map[string]any{
		"vin":         c.vin,
		"running":     c.running,
		"published":   c.published,
		"messageType": c.messageType,
		"components":  comps,
	}
}

// isComponentEnabled reports whether a component is currently publishing.
func (c *controlState) isComponentEnabled(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	comp, ok := c.components[id]
	return ok && comp.enabled
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
		VIN:            *vin,
		pkiStrategy:    *pkiStrategy,
		MessageType:    *messageType,
		controlSubject: *controlSubject,
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
		jwt, err = client.AuthenticateWithKeycloak()
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
func (v *VehicleClient) AuthenticateWithKeycloak() (string, error) {
	log.Println("Authenticate With Keycloak Step 1: Configuring mTLS with operational certificate...")

	// Create TLS certificate from operational cert and key
	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(v.operationalKey),
	})

	cert, err := tls.X509KeyPair(v.operationalCertPEM, keyPEM)
	if err != nil {
		return "", fmt.Errorf("failed to create X509 key pair: %w", err)
	}

	// Load CA certificate for the Keycloak server
	keycloakCA, err := os.ReadFile("certificates/KEYCLOAK_TLS_CRT.pem")
	if err != nil {
		return "", fmt.Errorf("failed to load Keycloak CA: %w", err)
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
		return "", fmt.Errorf("failed to create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to request token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("token request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp KeycloakTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("failed to decode token response: %w", err)
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

	return tokenResp.AccessToken, nil
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
	jwt, err := v.AuthenticateWithKeycloak()
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
	// Initial battery state
	battery := batteryState{
		voltage: 12.6,
		current: 45.2,
		soc:     85.5,
		temp:    25.3,
	}

	// Randomized drive cycle state (velocity, engine, GPS, dynamics)
	drive := newDriveState()

	// JWT refresh parameters
	var nc *nats.Conn
	var jwtExpiry time.Time
	refreshBuffer := 60 * time.Second // Refresh JWT 60 seconds before expiry

	// Control state for start/stop/status when a control subject is configured.
	// Declared before the refresh helpers so ensureControlSub can re-attach the
	// same handler to every fresh connection.
	ctl := newControlState(v.VIN, v.MessageType)

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
		sub, err := nc.Subscribe(v.controlSubject, func(msg *nats.Msg) {
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
		jwt, err := v.AuthenticateWithKeycloak()
		if err != nil {
			return fmt.Errorf("failed to get JWT: %w", err)
		}

		// JWT expires in 2 weeks (1209600 seconds, matching Keycloak realm config)
		jwtExpiry = time.Now().Add(1209600 * time.Second)
		log.Printf("JWT refreshed, expires at: %s", jwtExpiry.Format(time.RFC3339))

		nc, err = nats.Connect(v.natsURL, nats.Token(jwt))
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
		// Check if JWT needs refresh
		if time.Until(jwtExpiry) < refreshBuffer {
			log.Println("JWT expiring soon, refreshing connection...")
			if err := refreshConnection(); err != nil {
				log.Printf("Failed to refresh connection: %v", err)
				return
			}
		}

		// Simulate realistic battery variations
		battery.voltage += (mathrand.Float64() - 0.5) * 0.2 // ±0.1V
		battery.current += (mathrand.Float64() - 0.5) * 5.0 // ±2.5A
		battery.soc -= mathrand.Float64() * 0.1             // Slowly discharge
		battery.temp += (mathrand.Float64() - 0.5) * 1.0    // ±0.5°C

		// Keep battery values in realistic ranges
		battery.voltage = clamp(battery.voltage, 11.0, 14.5)
		battery.current = clamp(battery.current, 0, 100)
		if battery.soc < 10 {
			battery.soc = 90.0 // Reset to charged state
		}
		battery.temp = clamp(battery.temp, 15, 45)

		// Advance the randomized drive cycle (velocity, engine, GPS, dynamics).
		driveCycleStep(&drive, float64(intervalSeconds))

		now := time.Now()

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

	// Control loop: wait for start/stop over NATS when a control subject is
	// given; otherwise behave exactly as before (start publishing immediately).
	if v.controlSubject != "" {
		defer func() {
			if controlSub != nil {
				_ = controlSub.Unsubscribe()
			}
		}()
		log.Printf("Awaiting start command on %s", v.controlSubject)
		for range ticker.C {
			if ctl.isRunning() {
				publishOnce() // one tick while running
			}
			if time.Until(jwtExpiry) < refreshBuffer {
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
