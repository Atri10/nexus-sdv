package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"cloud.google.com/go/bigtable"
	"github.com/nats-io/nats.go"
	"go.uber.org/zap"
	"google.golang.org/protobuf/proto"

	telemetry "nats-bigtable-connector/api/gen/telemetry"
)

func main() {
	logger, _ := zap.NewDevelopment()
	defer logger.Sync()

	natsURL := getEnv("NATS_URL", "nats://connector:connector-pass@nats:4222")
	emulatorHost := getEnv("BIGTABLE_EMULATOR_HOST", "bigtable-emulator:8086")
	project := getEnv("GCP_PROJECT", "test-project")
	instance := getEnv("BT_INSTANCE", "test-instance")
	tableName := getEnv("BT_TABLE", "telemetry")

	logger.Info("Starting NATS -> Bigtable connector",
		zap.String("nats_url", natsURL),
		zap.String("emulator_host", emulatorHost),
		zap.String("project", project),
		zap.String("instance", instance),
		zap.String("table", tableName))

	// Set emulator host for Bigtable client
	os.Setenv("BIGTABLE_EMULATOR_HOST", emulatorHost)
	os.Setenv("GOOGLE_CLOUD_PROJECT", project)

	// Connect to NATS
	nc, err := nats.Connect(natsURL)
	if err != nil {
		logger.Fatal("Failed to connect to NATS", zap.Error(err))
	}
	defer nc.Drain()
	logger.Info("Connected to NATS")

	// Connect to Bigtable emulator
	ctx := context.Background()
	btClient, err := bigtable.NewClient(ctx, project, instance)
	if err != nil {
		logger.Fatal("Failed to create Bigtable client", zap.Error(err))
	}
	defer btClient.Close()

	tbl := btClient.Open(tableName)
	logger.Info("Connected to Bigtable emulator")

	// Subscribe to telemetry-generic subjects
	sub, err := nc.Subscribe("telemetry-generic.>", func(msg *nats.Msg) {
		var tm telemetry.TelemetryMessage
		if err := proto.Unmarshal(msg.Data, &tm); err != nil {
			logger.Error("Failed to unmarshal TelemetryMessage", zap.Error(err))
			return
		}

		logger.Debug("Received TelemetryMessage",
			zap.String("device_id", tm.DeviceId),
			zap.Int("sensor_count", len(tm.SensorData)),
			zap.String("subject", msg.Subject))

		for _, reading := range tm.SensorData {
			// Format timestamp to match data-api format
			ts := reading.Timestamp.AsTime()
			timestampStr := ts.Format("2006-01-02T15:04:05.000000000Z07:00")

			family := "dynamic"
			switch reading.DataType {
			case telemetry.DataType_STATIC:
				family = "static"
			case telemetry.DataType_DYNAMIC:
				family = "dynamic"
			}

			mut := bigtable.NewMutation()
			mut.Set(family, reading.Sensor, bigtable.Now(), []byte(reading.Value))

			rowKey := fmt.Sprintf("%s#%s", tm.DeviceId, timestampStr)
			if err := tbl.Apply(ctx, rowKey, mut); err != nil {
				logger.Error("Failed to write to Bigtable",
					zap.String("row_key", rowKey),
					zap.Error(err))
				continue
			}

			logger.Debug("Wrote to Bigtable",
				zap.String("row_key", rowKey),
				zap.String("family", family),
				zap.String("sensor", reading.Sensor))
		}
	})
	if err != nil {
		logger.Fatal("Failed to subscribe to NATS", zap.Error(err))
	}
	defer sub.Unsubscribe()

	logger.Info("Subscribed to telemetry-generic.>")
	// Subscribe to MetricsReport subjects (telemetry.{VIN}).
	// MetricsReport is an envelope; the real payload lives in report_data,
	// a google.protobuf.Any wrapping VehicleTelemetryData.
	subMetrics, err := nc.Subscribe("telemetry.>", func(msg *nats.Msg) {
		var mr telemetry.MetricsReport
		if err := proto.Unmarshal(msg.Data, &mr); err != nil {
			logger.Error("Failed to unmarshal MetricsReport", zap.Error(err))
			return
		}

		// Subject format: telemetry.{VIN}
		parts := strings.Split(msg.Subject, ".")
		if len(parts) < 2 {
			logger.Warn("MetricsReport subject missing VIN", zap.String("subject", msg.Subject))
			return
		}
		vin := parts[1]

		if mr.ReportData == nil {
			logger.Warn("MetricsReport has no report_data", zap.String("subject", msg.Subject))
			return
		}
		var vtd telemetry.VehicleTelemetryData
		if err := mr.ReportData.UnmarshalTo(&vtd); err != nil {
			logger.Error("Failed to unpack VehicleTelemetryData", zap.Error(err))
			return
		}

		ts := mr.ReportTimestamp.AsTime()
		if ts.IsZero() {
			ts = time.Now()
		}
		timestampStr := ts.Format("2006-01-02T15:04:05.000000000Z07:00")
		rowKey := fmt.Sprintf("%s#%s", vin, timestampStr)

		// Write each scalar field as a dynamic sensor column.
		mut := bigtable.NewMutation()
		addMetric := func(qualifier string, value float64) {
			mut.Set("dynamic", qualifier, bigtable.Now(), []byte(fmt.Sprintf("%.2f", value)))
		}
		addMetric("ENGINE_POWER", float64(vtd.ENGINE_POWER))
		addMetric("ENGINE_RPM", float64(vtd.ENGINE_RPM))
		addMetric("FUEL_CAPACITY", float64(vtd.FUEL_CAPACITY))
		addMetric("FUEL_LEVEL", float64(vtd.FUEL_LEVEL))
		addMetric("TIRE_PRESSURE", float64(vtd.TIRE_PRESSURE))
		addMetric("VELOCITY", float64(vtd.VELOCITY))
		if vtd.GPS_LATITUDE != nil {
			addMetric("GPS_LATITUDE", float64(*vtd.GPS_LATITUDE))
		}
		if vtd.GPS_LONGITUDE != nil {
			addMetric("GPS_LONGITUDE", float64(*vtd.GPS_LONGITUDE))
		}
		if vtd.VehicleDynamics != nil {
			addMetric("STEERING_ANGLE_DEG", vtd.VehicleDynamics.SteeringAngleDeg)
			addMetric("ACCELERATOR_PEDAL_PCT", vtd.VehicleDynamics.AcceleratorPedalPct)
			addMetric("BRAKE_PEDAL_PCT", vtd.VehicleDynamics.BrakePedalPct)
		}

		if err := tbl.Apply(ctx, rowKey, mut); err != nil {
			logger.Error("Failed to write MetricsReport to Bigtable",
				zap.String("row_key", rowKey),
				zap.Error(err))
			return
		}

		logger.Debug("Wrote MetricsReport to Bigtable",
			zap.String("row_key", rowKey),
			zap.String("vin", vin))
	})
	if err != nil {
		logger.Fatal("Failed to subscribe to telemetry.>", zap.Error(err))
	}
	defer subMetrics.Unsubscribe()

	logger.Info("Subscribed to telemetry.> (MetricsReport)")

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	logger.Info("Shutting down...")
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}