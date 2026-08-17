# nats-bigtable-connector — Telemetry Ingestion for Predictive Maintenance

> Audience: engineers working on the predictive-maintenance (PM) pipeline or
> extending the telemetry schema. This document explains what this service
> does, why it's built the way it is, and exactly how it turns NATS
> messages into the Bigtable rows that `data-api` and the
> `predictive-maintenance` detector service read back.
>
> Service: `base-services/nats-bigtable-connector`. The entire service is
> one Go file, `src/main.go` (function `main`, helpers `metricFormat`,
> `getEnv`, `ensureTable`), tested by `src/main_test.go`. Proto schemas live
> in `proto/telemetry.proto`, `proto/metrics_report.proto`,
> `proto/vehicle_telemetry.proto`. All citations below are file + function
> name, not line numbers.

---

## 1. What this service is, in plain terms

Picture the vehicle simulator (or a real car) shouting sensor readings out
onto a radio channel (NATS) continuously: "battery voltage is 12.4V!",
"front-left tire is 2.1 bar!", "speed is 22 m/s!". Nobody can *ask
questions* of a radio broadcast — you can only catch messages as they fly
by. This service's entire job is to sit there permanently listening to
that channel, catch every message, and write each one down into a
database (Bigtable) as a durable row — so that later, another service can
come along and ask "what was VIN1002's battery voltage over the last 30
days?" and get a real answer instead of "I don't know, I wasn't listening
at the time."

It is a pure **ingest-and-store** service: it does no analysis, no
alerting, no math on the values — it decodes messages and writes rows,
nothing else. That's a deliberate architectural boundary — decoupling
"getting data safely into storage" from "deciding what the data means" (the
`predictive-maintenance` service's job) means either half can be changed,
restarted, or scaled independently without touching the other.

---

## 2. Data flow

```mermaid
flowchart LR
    SIM["vehicle-simulator"] -->|"telemetry-generic.{VIN}.{sensor}\n(TelemetryMessage)"| NATS[(NATS)]
    SIM -->|"telemetry.{VIN}\n(MetricsReport → Any → VehicleTelemetryData)"| NATS
    NATS --> H1["telemetry-generic.> handler\nmain.go: main"]
    NATS --> H2["telemetry.> handler\nmain.go: main"]
    H1 -->|"per SensorReading:\nfamily=static/dynamic, qualifier=reading.Sensor"| BT[("Bigtable\ntable: telemetry\nfamilies: dynamic, static")]
    H2 -->|"addMetric(qualifier, value)\nfamily=dynamic always"| BT
    BT --> API["data-api gRPC"]
```

Two independent NATS subscriptions are registered in `main()`, each with
its own inline handler closure — there are no separate parser
files/functions, everything happens right where the subscription is set
up:

- **`telemetry-generic.>`** (wildcard) — generic per-sensor messages. Any
  publisher (the simulator, or a real device) can name an arbitrary sensor
  string (`"battery.voltage"`, `"TIRE_PRESSURE.FL"`) and this path stores
  it verbatim.
- **`telemetry.>`** (wildcard, subject shape `telemetry.{VIN}`) — the
  older, fixed-schema envelope with one flat message holding named scalar
  fields (`ENGINE_RPM`, `VELOCITY`, `TIRE_PRESSURE`, …). The VIN here is
  parsed out of the **subject itself** (`strings.Split(msg.Subject, ".")`,
  taking the second token) — not out of the message payload.

There is **no `commands.>` subscription** here — the connector never
touches control/start/stop messages; those are consumed directly by the
vehicle simulator.

---

## 3. Decoding two different message shapes

**In plain terms:** the platform actually speaks two different "dialects"
of telemetry for historical/compatibility reasons (see the vehicle-client
docs for why), and this connector is bilingual — it understands both and
translates both into the same underlying storage format.

- **`telemetry-generic.>`** — `proto.Unmarshal(msg.Data, &tm)` into a
  `telemetry.TelemetryMessage` (`proto/telemetry.proto`). The handler then
  walks `tm.SensorData` (`[]*SensorReading`), one Bigtable write per
  reading.
- **`telemetry.>`** — `proto.Unmarshal(msg.Data, &mr)` into a
  `telemetry.MetricsReport` (`proto/metrics_report.proto`). The actual
  payload is wrapped in a `google.protobuf.Any` field (`mr.ReportData`);
  the handler unpacks it with `mr.ReportData.UnmarshalTo(&vtd)` into a
  `telemetry.VehicleTelemetryData` (`proto/vehicle_telemetry.proto`). If
  `ReportData` is nil, the handler logs a warning and drops the message —
  this happens, for example, if a future message type is published that
  this build doesn't know how to unpack yet.

The three `.proto` files carry provenance comments citing the original
Android SDV Telemetry Service field-number sources (e.g. field numbers
sourced from a real device's `metrics_configuration.proto` sample) — these
field numbers are an **external compatibility contract**, not free to
renumber casually.

---

## 4. The `dynamic:<sensor>` column convention — why per-wheel PM detection works

This is the single most important design detail for anyone extending the
telemetry schema (e.g. adding a new sensor, a new wheel-position metric, a
new component).

**In plain terms:** Bigtable rows don't have a fixed set of columns like a
spreadsheet — each row can have as many or as few "column qualifiers" as
you want, and the qualifier is just a string you choose at write time. The
connector exploits this: instead of hardcoding a fixed list of columns like
`tire_pressure_fl`, `tire_pressure_fr`, ..., it just takes whatever sensor
name the publisher sent (`"TIRE_PRESSURE.FL"`, `"BRAKE_WEAR.RR"`,
`"battery.voltage"`) and uses that *exact string* as the Bigtable column
qualifier, unmodified. The connector has no idea what "FL" or "battery"
mean — it treats the whole string as an opaque label and stores it as-is.

Concretely, on the generic path (`main.go`, `telemetry-generic.>` handler),
for each `SensorReading`:

```
family := "dynamic"  // or "static", from reading.DataType
qualifier := reading.Sensor          // e.g. "TIRE_PRESSURE.FL", verbatim
mut.Set(family, qualifier, bigtable.Now(), []byte(reading.Value))
```

On the `MetricsReport` path, a helper closure `addMetric(qualifier,
value)` does the equivalent for each populated scalar field of
`VehicleTelemetryData` (`ENGINE_RPM`, `TIRE_PRESSURE`, `VELOCITY`, …) — this
path always writes to the `dynamic` family; there's no static-field write
here.

Because the connector never parses or validates the qualifier string, a
publisher is free to invent a dotted, structured-looking name like
`TIRE_PRESSURE.FL` and the connector will faithfully store a column
literally named `dynamic:TIRE_PRESSURE.FL` — **with no connector code
change required**. This is exactly how the vehicle-simulator's per-wheel
telemetry (`buildChassisWheelTelemetry`, see the vehicle-client docs)
reaches Bigtable, and exactly how `predictive-maintenance`'s
`processor.py(run)` reads it back — it requests the literal column filter
`dynamic:TIRE_PRESSURE.FL`. **If you rename a sensor string on the
publish side without updating the detector's column filter, the detector
silently stops seeing that sensor** — there's no schema validation
anywhere in this pipeline to catch a mismatch.

Numeric formatting: `metricFormat(qualifier)` (top of `main.go`) special-
cases `GPS_LATITUDE`/`GPS_LONGITUDE` to 6 decimal places and everything
else to 2. Every value, on both paths, is stored as an ASCII-formatted
string (`[]byte(fmt.Sprintf(...))` or the raw `reading.Value` string) — not
as a binary-encoded number. This is why the PM processor "strips quotes"
when reading values back (see the predictive-maintenance docs) — the
values genuinely are text in Bigtable.

Fields that are unset (`nil` proto3-optional scalars) are **skipped
entirely**, not written as zero — so a disabled telemetry component reads
as "no data for this tick" downstream, never as a false zero reading.

---

## 5. Row key and table schema

Row key (identical construction on both paths):

```
{VIN}#{RFC3339-ish timestamp}
```

built by `fmt.Sprintf("%s#%s", deviceIDOrVIN, timestampStr)` with the Go
time layout `"2006-01-02T15:04:05.000000000Z07:00"`. This is a plain
ascending timestamp (not reversed), chosen to match what `data-api`
expects when it does a row-range scan for a time window. The timestamp
source differs by path: the generic path uses the individual
`SensorReading`'s own timestamp; the `MetricsReport` path uses the
report's `ReportTimestamp` (falling back to "now" if unset).

**In plain terms:** think of the row key as "VIN, then when" glued
together with a `#`. Because it sorts as plain text, all of one VIN's rows
naturally sort together and in time order — which is exactly the access
pattern `data-api` needs to answer "give me VIN1002's last 30 days."

Column families: exactly two, `dynamic` and `static`, created once at
startup by `ensureTable()` (`main.go`), which lists existing tables via
the Bigtable admin client and creates the table + both families if
missing. The table name comes from `BT_TABLE` (default `telemetry`).
Because the Bigtable **emulator** used in local dev is in-memory and wipes
its schema on every container restart, `ensureTable()` failing at startup
is not treated as fatal — a background goroutine retries it every minute
indefinitely (`main.go`, ticker loop) until it succeeds, so a connector
that starts before the emulator is ready will self-heal once the emulator
comes up.

---

## 6. Write path, batching, and failure behavior

**In plain terms:** there is no batching or buffering at all here — every
single sensor reading becomes its own individual, synchronous, "write this
one row-column right now" call to Bigtable. This keeps the service simple
and the data as fresh as possible (no delay waiting for a batch to fill
up), at the cost of more individual Bigtable API calls than a batched
design would make. For the demo/local-dev telemetry volumes this is fine;
it's a design point worth revisiting before pointing this at a real
high-frequency production fleet.

- Every `SensorReading` (generic path) or every `MetricsReport` (metrics
  path) triggers exactly one `tbl.Apply(ctx, rowKey, mut)` call. No
  `ApplyBulk`, no queue, no worker pool.
- **On a Bigtable write failure**, the handler logs the error and drops
  that one message (`continue`s to the next reading, or `return`s for the
  metrics path) — there is no retry and no redelivery, because these are
  plain core-NATS subscriptions (no JetStream ack/nack semantics). A
  transient Bigtable blip therefore means **permanent loss of that one
  reading** — acceptable for a demo/local stack, a real risk to flag
  before production use.
- **On malformed input** — a protobuf that fails to unmarshal, a
  `telemetry.>` subject with no VIN token, a `MetricsReport` with a nil or
  mismatched `Any` payload — the handler logs and drops the message the
  same way. Nothing crashes the process; bad messages are just silently
  discarded (visible only in structured logs).
- **Startup failures are fatal**: if the initial NATS connection or the
  Bigtable client construction fails, the process calls `logger.Fatal` and
  exits — there's no fallback for "can't reach my dependencies at all,"
  only for "a dependency I already connected to briefly failed."
- **Shutdown** is graceful: on SIGINT/SIGTERM, the process drains the NATS
  connection (`nc.Drain()` — flushes in-flight messages and unsubscribes
  cleanly) and closes the Bigtable client before exiting.

---

## 7. Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NATS_URL` | `nats://connector:connector-pass@nats:4222` | NATS connection string (basic auth built in for local dev) |
| `BIGTABLE_EMULATOR_HOST` | `bigtable-emulator:8086` | Bigtable emulator address; also re-exported as `BIGTABLE_EMULATOR_HOST` so the Bigtable Go SDK picks it up automatically |
| `GCP_PROJECT` | `test-project` | GCP project ID for the Bigtable client (also re-set as `GOOGLE_CLOUD_PROJECT`) |
| `BT_INSTANCE` | `test-instance` | Bigtable instance ID |
| `BT_TABLE` | `telemetry` | Bigtable table name — must match what `data-api` reads from |

Local dev sets all five explicitly in `local-dev/docker-compose.yml`
(service `nats-bigtable-connector`). Production deployment
(`.github/workflows/deploy-nats-bigtable-connector.yml`) pulls NATS
credentials and a Bigtable-connector GCP service account from Secret
Manager rather than hardcoding them — Bigtable auth in a real GCP
environment relies on that service account's Application Default
Credentials, not on any code in this service.

---

## 8. Concurrency, observability, and known gaps

- **Concurrency**: `main()` sets up two NATS subscriptions (each callback
  runs on the NATS client library's own per-subscription dispatch
  goroutine) plus one background goroutine for the minute-ly
  `ensureTable` retry ticker. There is no explicit worker pool or
  concurrency limiter in this service's own code — throughput is however
  many concurrent Bigtable `Apply` calls NATS message delivery generates.
- **Observability**: structured logging only, via `zap`
  (`go.uber.org/zap`). There is **no HTTP health endpoint and no metrics
  exporter** — if you need to know this service is alive and keeping up,
  today that means reading logs, not scraping a `/healthz` or
  `/metrics` endpoint. This is a reasonable gap to flag for anyone
  hardening this for production.
- **Unpersisted fields**: several `VehicleTelemetryData` fields the
  simulator *could* publish are never written to Bigtable by this
  connector — notably `acceleration_modulus_m_s2`, `distance_meters`,
  `IGNITION_STATE`, `LOCKED`, `gear_status`. This is why the PM detector
  can't use a real acceleration sensor for brake-energy estimation and
  instead derives deceleration from consecutive `VELOCITY` readings (see
  the predictive-maintenance service docs) — the raw signal that would
  make that estimate more precise simply never reaches storage today.

---

## 9. Extending the schema

To add a new sensor that the PM detector (or any other consumer) should be
able to read per-instance (e.g. per wheel, per pad):

1. Publish it on the **generic** path (`telemetry-generic.{VIN}.{group}`)
   as a `SensorReading` with a unique `Sensor` string, e.g.
   `"NEW_SENSOR.FL"`. **No connector code change is needed** — this is the
   entire point of the `dynamic:<sensor>` convention.
2. Confirm the exact qualifier string on both ends matches character for
   character — the connector does zero validation, so a typo on either
   side (publisher vs. consumer) fails silently rather than erroring.
3. If the new sensor should also appear on the legacy `telemetry.{VIN}`
   typed path for back-compat, add a field to `VehicleTelemetryData`
   (`proto/vehicle_telemetry.proto`) and a corresponding `addMetric(...)`
   call in the `telemetry.>` handler (`main.go`) — this path *does*
   require a connector code change, since its fields are named
   individually rather than generic.

---

## 10. Quick reference

| Question | Function / File |
|---|---|
| What subjects does it listen to? | `main.go` · `main` (two `nc.Subscribe` calls) |
| How is a generic sensor reading decoded? | `main.go` · `main` (`telemetry-generic.>` handler), `proto/telemetry.proto` |
| How is a MetricsReport decoded? | `main.go` · `main` (`telemetry.>` handler), `proto/metrics_report.proto`, `proto/vehicle_telemetry.proto` |
| How does a sensor name become a Bigtable column? | `main.go` · `main` (`mut.Set(family, reading.Sensor, ...)`), `main.go` · `addMetric` |
| What's the row key format? | `main.go` · `main` (`fmt.Sprintf("%s#%s", ...)`) |
| How is the table/column-family schema created? | `main.go` · `ensureTable` |
| What happens on a bad message or a Bigtable write failure? | `main.go` · `main` (logged + dropped, no retry) |
| What env vars configure it? | `main.go` · `getEnv` calls at top of `main` |
