# Telemetry Message Structure

Predictive-maintenance inputs travel through two telemetry representations.
They are compatible at the storage boundary but not interchangeable at the
protobuf boundary.

## Generic sensor messages

`telemetry.TelemetryMessage` contains:

```text
message_id
schema_version
device_id
sensor_data[]
```

Each `SensorReading` contains a timestamp, string value, `DataType`, and sensor
name. The vehicle client uses this form for battery readings and per-wheel
chassis readings. For example, one wheel message contains the three sensor
names `TIRE_PRESSURE.FL`, `TIRE_TEMP.FL`, and `BRAKE_WEAR.FL`.

The message is published to a subject constructed from the VIN and logical
sensor group:

```text
telemetry-generic.{VIN}.battery
telemetry-generic.{VIN}.chassis
```

## Typed metrics reports

`google.sdv.telemetry.MetricsReport` is an envelope. Its `report_data` field is
`google.protobuf.Any`; the vehicle client packs
`com.android.sdv.telemetry.VehicleTelemetryData` into it. The typed chassis
message includes optional fields such as `VELOCITY`, `TIRE_PRESSURE`,
`TIRE_TEMP`, `IGNITION_STATE`, and nested `vehicle_dynamics`.

Typed reports are published to:

```text
telemetry.{VIN}
```

The connector unpacks `Any`, maps typed fields to uppercase dynamic qualifiers,
and uses the subject VIN for the row identity. The generic path uses the
message `device_id` and sensor names.

## Encoding and storage mapping

| Source | Stored key | Stored value |
|---|---|---|
| Generic `SensorReading` | `dynamic:<sensor>` or `static:<sensor>` | Raw string bytes. |
| Typed `VehicleTelemetryData` | `dynamic:<field name>` | Connector-formatted scalar bytes. |

The processor requests the full key, for example
`dynamic:TIRE_PRESSURE.FL`. The dot in a per-wheel sensor name is part of the
qualifier; it is not a NATS subject separator after storage.

## PM output message

The detector serializes:

```text
PmMessage {
  string vin
  string component
  int32 health_score
  string severity
  map<string, string> evidence
  string explanation
  string timestamp
}
```

`evidence` is deliberately string-valued so detector-specific measurements can
be added without changing the protobuf for every component. The web route
decodes this message and adds the wheel/pad token from four-part subjects when
needed.

## Contract implications

- Changing a sensor name changes its Bigtable qualifier and the processor's
  Data API filter.
- Changing a protobuf field requires regenerating service-local stubs and
  updating the connector mapping.
- Adding a wheel or pad component requires subject, evidence, UI grouping, and
  fallback behavior to remain consistent.
- Raw telemetry and PM results are separate contracts; PM results are not
  stored as telemetry rows by this path.

## Sources

- [`telemetry.proto`](../../../../proto/telemetry.proto)
- [`vehicle_telemetry.proto`](../../../../proto/vehicle_telemetry.proto)
- [`metrics_report.proto`](../../../../proto/metrics_report.proto)
- [`pm-message.proto`](../../../../sample-services/predictive-maintenance/proto/pm-message.proto)
- [`nats-bigtable-connector/src/main.go`](../../../../base-services/nats-bigtable-connector/src/main.go)
- [`2026-08-15-pm-use-case-end-to-end.md`](../../../../docs/superpowers/research/2026-08-15-pm-use-case-end-to-end.md)
