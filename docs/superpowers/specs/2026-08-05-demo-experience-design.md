# Interactive Demo Experience — Design & Spec

- Date: 2026-08-05
- Branch: `feat/local-dev-no-gcp`
- Status: design approved → implementation plan

## 1. Goal

Make the local stack demoable in one command with an interactive, animated
sample page: show **which vehicle component produces what data**, **where that
data flows** (component → NATS → connector → Bigtable → chart), and **the live
graph** of it — plus one-click start for the project, the vehicle, and
telemetry, with randomized vehicles and no hardcoded-VIN coupling.

## 2. Decisions (user-approved)

1. **NATS-controlled simulator service** — the vehicle simulator becomes a
   compose service that is always up but idle, controlled over NATS
   request/reply on `commands.<VIN>.demo`. Dashboard buttons → web API route →
   NATS → simulator. No docker socket, no host tooling.
2. **Realm VIN pool** — 10 confidential clients `VIN1001`–`VIN1010` with
   service-account roles; simulator picks a random pool VIN per run. Per-VIN
   auth model (azp = client id = VIN) preserved; auth-callout untouched.
3. **New `/demo` page** — interactive SVG vehicle schematic (components →
   sensors → live values), animated data-path pipeline, live chart + KPI strip.
4. **`make demo` + dashboard buttons** — one command from clone to demo.

## 3. Architecture

### 3.1 Simulator control (NATS)

- New compose service `vehicle-simulator`, built from
  `sample-clients/vehicle-client` via a new `Dockerfile.local` (multi-stage:
  protoc → go build) and an `entrypoint.sh` (mint factory cert from the
  mounted factory CA, stage TLS certs the client reads unconditionally, run
  the binary).
- Binary gains an additive `-control-subject` flag (default empty = current
  host behavior). When set: after registration + JWT, subscribe to
  `commands.<VIN>.demo`, await `{"action":"start"|"stop"|"status"}`; `start`
  begins the publish ticker, `stop` pauses it (connection kept), `status`
  replies with running state + VIN + counters. Replies go to the request's
  reply subject.
- In-container env: `REGISTRATION_URL=https://registration:8443`,
  `KEYCLOAK_URL=http://keycloak:8080`, `NATS_URL=nats://nats:4222`,
  `KEYCLOAK_REALM=nexus-sdv`, `KEYCLOAK_CLIENT_ID=<pool VIN>`, secret via env
  (deterministic `vin10XX-secret`), certs mounted from `local-dev/certs`.
- Web control route `/api/demo/vehicle` (POST `{action, vin}`) publishes a
  NATS request on `commands.<VIN>.demo` using the existing connector
  connection (`getNatsScoringConnection`) and returns the simulator's reply.
  Requires `commands.>` publish for the connector user in the generated
  `config/nats.conf` (setup-automated.sh `phase_nats_config`).
- The simulator's own JWT (`edge-device` role) already grants
  `commands.<VIN>.>` subscribe — no auth-callout/Keycloak change beyond the
  realm pool.

### 3.2 Randomization

- Realm pool: 10 clients + 10 `service-account-vin10XX` users. Generation via
  a committed script (`local-dev/scripts/generate-vin-pool.py` or bash+jq —
  Python preferred, deterministic) that emits the JSON blocks; the resulting
  `nexus-realm.json` is committed.
- Simulator randomization (per run, controlled by env/flag defaults):
  - VIN: random pool member.
  - Start state: SoC 60–95%, fuel 20–80%, base GPS position (city center ±
    0.01°), velocity 0.
  - Drive cycle: velocity follows a smooth profile (accelerate → cruise →
    brake → idle) with randomized segment lengths; derived sensors (RPM,
    power, accelerator/brake) correlate with velocity instead of independent
    random walks.
  - Both message types each tick: battery (TelemetryMessage →
    `telemetry.<VIN>.battery`) and engine/GPS (MetricsReport →
    `telemetry.<VIN>`).
- Fleet page discovers pool VINs automatically via Bigtable key scan — no
  VIN123 coupling anywhere in the demo path. VIN123 keeps working for the
  smoke test and existing flows.

### 3.3 `/demo` page

Layout (Real-Time Monitoring design language — blue/amber, dark+light,
mono numerics, existing components reused):

1. **Controls bar**: vehicle selector + "New vehicle" (random pool VIN),
   Start/Stop Telemetry buttons, pulsing status badge (reuse `live-ping`),
   link to fleet.
2. **Vehicle schematic** — SVG car with 4 interactive component nodes:
   - Battery → `dynamic:battery.voltage/current/soc/temp`
   - Powertrain → `dynamic:ENGINE_POWER`, `dynamic:ENGINE_RPM`,
     `dynamic:FUEL_LEVEL`, `dynamic:VELOCITY`
   - Chassis/GPS → `dynamic:GPS_LATITUDE`, `dynamic:GPS_LONGITUDE`,
     `dynamic:STEERING_ANGLE_DEG` (verify actual connector qualifiers at
     implementation), accelerator/brake
   - Cabin → `dynamic:battery.temp` (shared) + `static:make`/`static:index`
     (static metadata)
   Click a component → highlight + sensor chips with **live values** (WS via
   chart service). Active components pulse (reuse `live-ping`).
3. **Animated data path** — SVG pipeline `Component → NATS telemetry.{VIN} →
   connector → Bigtable → chart service → graph`; CSS `stroke-dashoffset`
   flow animation while telemetry runs (disabled under
   `prefers-reduced-motion`); the selected sensor's hop highlights.
4. **Live graph + KPI strip** — reuse `TelemetryChart` + `LatestStats`,
   filtered to the selected component's sensors.

Pure CSS/SVG animations — no new dependencies. Route `/demo` added to the
middleware matcher; sidebar link added.

### 3.4 One-click start

`make demo` (local-dev/Makefile): `make go` if not running → start
`vehicle-simulator` → `open http://localhost:3000/demo`. Dashboard buttons
replace manual terminal control afterward.

## 4. Files

- Modify: `sample-clients/vehicle-client/main.go` (control mode, both message
  types, drive-cycle + GPS randomization, random-VIN default)
- Create: `sample-clients/vehicle-client/Dockerfile.local`,
  `sample-clients/vehicle-client/entrypoint.sh`
- Modify: `local-dev/docker-compose.yml` (simulator service),
  `local-dev/configs/sample-services.template` (simulator env),
  `local-dev/setup-automated.sh` (nats.conf `commands.>` publish perm),
  `local-dev/Makefile` (`demo` target)
- Create: `local-dev/scripts/generate-vin-pool.py`; modify
  `local-dev/keycloak/nexus-realm.json` (pool)
- Modify (web): `src/lib/nats.ts` (control helper), new
  `src/app/api/demo/vehicle/route.ts`, `src/app/api/demo/vehicles/route.ts`,
  new `src/app/demo/page.tsx` + `src/components/demo/*` (schematic,
  data-path, control bar), `middleware.ts`, `sidebar.tsx`
- Tests: Go unit tests for drive-cycle/randomization + control message
  handling (pure parts); web tests for component metadata + demo helpers
  (bun). Full suites stay green.
- Docs: `local-dev/README.md` (demo section), `local-dev/ARCHITECTURE.md`
  (simulator + control flow).

## 5. Acceptance criteria

- `make demo` from a clean clone: stack up, random vehicle registered, browser
  opens `/demo`.
- `/demo` shows components with live values; Start/Stop buttons toggle
  telemetry via NATS; the data-path flow animates while running; the graph
  tracks the selected sensor.
- Two consecutive `make demo` runs produce different VINs (randomized).
- `make vehicle-client` (host path) still works; `make test` still passes
  (smoke uses VIN123, unaffected).
- Web suite green (bun), Go tests green, `bash -n` clean, `bun run build`
  green.

## 6. Out of scope

- Auth for the demo page (same posture as device pages).
- Multiple simultaneous simulators in the UI (single vehicle at a time; the
  pool supports more later).
- GCP-side changes (simulator is local-dev only).
- AAOS telemetry.

## 7. Risks

- Connector qualifier names for MetricsReport fields must be verified against
  the generated stubs at implementation time (uppercase underscore style) —
  component metadata references the real qualifiers.
- NATS request/reply timeout: simulator must be registered+connected before
  the web route can reach it; the route returns a clear "simulator offline"
  error and the UI surfaces it (retry hint) instead of hanging.
- Registration in-container: echoed client URLs are host-reachable values;
  the simulator must set `KEYCLOAK_URL`/`NATS_URL` env so the client never
  uses the echoed host URLs (verify the reuse-existing-certs path honors env).
