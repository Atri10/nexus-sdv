package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

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