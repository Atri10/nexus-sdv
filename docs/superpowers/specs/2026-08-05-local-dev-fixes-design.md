# Local-Dev Fix Batch — Design & Findings

- Date: 2026-08-05
- Branch: `feat/local-dev-no-gcp` (fork of `GoogleCloudPlatform/nexus-sdv`, Release 1.2.0)
- Status: design approved → implementation
- Scope: G1–G6 (all verified review findings). `main` and `origin/main` remain untouched.

## 1. Background

The fork adds a fully local (no-GCP) stack — NATS + Keycloak + Bigtable emulator + all services — plus ingestion-loop fixes, a new Java `telemetry-chart-service`, and a shadcn/Chart.js frontend rework (35 commits). A four-pass review (git archaeology + 4 static review passes) found 3 critical, ~10 major, and ~20 minor defects. This spec documents the findings (Section 2) and the approved design to fix all of them (Section 4). See prior review summary for the full evidence trail.

## 2. Findings inventory (all verified by direct inspection unless marked [runtime])

| ID | Sev | Location | Problem | Fix group |
|---|---|---|---|---|
| F1 | critical | `base-services/auth-callout/main.go:166-167,210,226` + `keycloak/nexus-realm.json` | NATS perms keyed to `azp` (client id); local client publishes `telemetry.<VIN>.>` → `Authorization Violation`; service account has no realm roles → zero perms | G1 |
| F2 | critical | `data-web-client/src/hooks/use-telemetry-data.ts` | `load()` computes historical result but never stores it (`setSeries` missing) — historical/compare/retry silently dead | G2 |
| F3 | critical | web-client test infra | 3 tests import `bun:test`; jest `testMatch` misses `src/**`; `npm test` crashes; no CI job | G2 |
| F4 | major | `TelemetryWebSocketHandler.java:128,109-116` | 1s poll `ScheduledFuture` never cancelled on close; scheduler never shut down → per-connection thread/task leak, JVM won't exit | G3 |
| F5 | major | `TelemetryWebSocketHandler.java:101-105` + `TelemetryService.java:255-259` | unsubscribe passes *remaining* set → removes still-active columns; corrupts shared per-VIN state | G3 |
| F6 | major | `TelemetryService.java` | `liveSubscriptions` map written never read (dead bookkeeping); `broadcastLiveData()` empty; poll runs with empty subscription set | G3 |
| F7 | major | `TelemetryService.java:137` | `endKey = vin+"0"` leaks sibling-prefix VIN rows (`VIN123-*`); intent cryptic | G3 |
| F8 | major | `TelemetryService.java:104-112` | unbounded Bigtable scan; controller `limit` applied post-scan; half-open end range excludes exact-end row | G3 |
| F9 | major | `TelemetryService.java:169-183` | `parseRow` fabricates `Instant.now()` on unparseable keys; errors swallowed into empty results | G3 |
| F10 | major | `BigtableConfig.java` + `TelemetryService.java` | duplicate Bigtable clients; unused admin client; `System.setProperty` side effects | G3 |
| F11 | major | `SecurityConfig.java` + `WebSocketConfig.java` | `permitAll` everywhere, actuator open, `show-details: always`, WS origins `*` | G3 |
| F12 | major | `TelemetryController.java:26-27` | hardcoded VIN list; unhandled `Instant.parse` → 500 | G3 |
| F13 | major | `application.yml` | hardcoded port 8080; DEBUG default; health details always | G3 |
| F14 | major | `nats-bigtable-connector/Dockerfile.local:23` | `COPY api/gen/telemetry` of gitignored dir → fresh-clone build failure | G4 |
| F15 | major | `.gitignore:57` `**/.mvn/**` | `telemetry-chart-service/.mvn/wrapper/maven-wrapper.properties` untracked → `./mvnw` fails on clean clone (upstream tracks it) | G4 |
| F16 | major | `data-api-sampler/pom.xml:46-57,152-163` | logback-classic excluded from repackaged jar → container runs with no logging backend; actuator-level exclusions are no-ops | G4 |
| F17 | major | `data-web-client/Dockerfile.local` | `TELEMETRY_SERVICE_URL` set in builder only; runner falls back to `localhost:8081` | G4 |
| F18 | minor | `setup-automated.sh:339` | `base64 -b 0` BSD-only → aborts on Linux hosts | G5 |
| F19 | minor | `scripts/wait-for-services.sh` | always exits 0; `eval` unnecessary; unused by Makefile/setup | G5 |
| F20 | minor | `setup-automated.sh:396` | `--status exited --status dead` last-wins → exited services missed; `phase_verify` omits 3 services | G5 |
| F21 | minor | `Makefile` clean + `generate-certs.sh` gating | `make clean` doesn't remove `certs/` (docs claim it does); cert gen gates on one file → partial PKI persists | G5 |
| F22 | minor | `nexus-realm.json:5` | `sslRequired: "external"` on HTTP-only stack; JWKS fetched without `-L` could store HTML [runtime] | G5 |
| F23 | minor | `configs/infra.template:12-13`, `configs/base-services.template:5-6` | live NATS account seed + real JWKS committed to git history; template-default stacks run on them | G5 |
| F24 | minor | `setup-automated.sh:64-74,238-240` | cleanup prompt is theater (env re-copied regardless); `read -p` hangs non-interactive runs | G5 |
| F25 | minor | `docker-compose.infra.yml:16-20` | NATS_* env block dead (config file given); real creds hardcoded in generated `nats.conf` | G5 |
| F26 | minor | `docker-compose.certs.yml:21-27` | unused named `certs` volume; `${PWD}` interpolation fragile; generate-certs.sh run under busybox ash (`[[ ]]`, process substitution) | G5 |
| F27 | minor | `scripts/generate-certs.sh:141-147` | "test device" cert signed by registration CA but registration validates against factory CA — dead artifact | G5 |
| F28 | minor | `config/mosquitto.conf` + `compose.infra.yml` | `allow_anonymous` on 0.0.0.0:1883; dead 8883 publish; `persistence true` without volume | G5 |
| F29 | minor | `data-web-client` middleware + SSE | middleware matcher only `/fleet/:path*`; scoring SSE emits plain text while `sidebar.tsx` `JSON.parse`s it; `__tests__/api/scoring/stream.test.ts` mocks wrong function | G2 |
| F30 | minor | docs drift | `local-dev/README.md` "no NATS→Bigtable writer" + "make clean regenerates PKI" stale; `data-web-client/docs/theming.md` documents HSL globals.css (actual: oklch) | G6 |
| F31 | nit | web client | `shadcn` CLI in `dependencies`; dead `ScoringAlerts.tsx`; stale `package-lock.json` beside `bun.lock` | G2 |
| F32 | — | `registration` compose mount | **Checked and cleared**: Dockerfile.local final stage is `FROM scratch` (CWD `/`), so relative `certificates` → `/certificates` — existing mount is correct | — |

Also verified clean: no fork-introduced secrets in history; MetricsReport ingestion correct; NATS `auth_callout` config shape correct; row-key format consistent across connector/data-api/chart-service/ingest script; env plumbing coherent; no references to deleted `local-dev/env/`.

## 3. Decisions (user-approved)

- **D1 (G1)**: per-VIN Keycloak confidential clients. `client_credentials` → `azp` = client id = VIN → existing auth-callout code grants `telemetry.<VIN>.>` and `commands.<VIN>.>`. Zero Go/Rust changes; upstream parity preserved.
- **D2 (G2)**: switch web-client tests to `bun test` (files already bun-native); remove jest infra.
- **D3**: scope = G1–G6, everything.
- **D4**: `main` / `origin/main` untouched; no branch renames/deletes in this pass.

## 4. Design

### G1 — Vehicle flow (F1)

1. `local-dev/keycloak/nexus-realm.json`: add confidential client `VIN123` (shape cloned from `vehicle-client`: `clientAuthenticatorType: client-secret`, `secret: vin123-secret`, `serviceAccountsEnabled: true`, realm-roles protocol mapper) and add user entry `service-account-vin123` with `serviceAccountClientId: "VIN123"` and `realmRoles: ["edge-device", "telemetry-client"]`. Keep the existing `vehicle-client` client (backward compatible; no roles).
2. `local-dev/scripts/run-vehicle-client.sh:95`: default `KEYCLOAK_CLIENT_ID` `vehicle-client` → `VIN123` (secret auto-read via existing `jq` lookup at lines 96-101).
3. `local-dev/scripts/test-local-flow.sh`: add a vehicle-flow test replacing the skip note — gated on host tooling (`go`, `protoc`, `jq`, `openssl`): record Bigtable row count for VIN123, run `run-vehicle-client.sh` in background ~15s, kill, assert row-count increase. Keep graceful skip when tooling missing (existing `mosquitto_pub` pattern).

Acceptance: `make vehicle-client` publishes without `Authorization Violation`; smoke test exercises the JWT→NATS→Bigtable path.
[runtime] Keycloak import applies service-account roles (token contains `realm_access.roles`).

### G2 — Frontend data path + test story (F2, F3, F29, F31)

1. `src/hooks/use-telemetry-data.ts`: `load()` must store the fetched result in series state (historical + compare paths; retry then works). Hook API unchanged — callers (`device/[id]/page.tsx`, chart components) untouched.
2. Migrate to `bun test`:
   - `package.json`: `"test": "bun test"`; remove `jest`, `jest-environment-jsdom`, `ts-node`, `@types/jest` (keep `@testing-library/*` only if referenced — verify; there are no DOM tests today).
   - Delete `jest.config.ts`, `jest.setup.ts`, `test/dom-preload.ts` (and stale `package-lock.json`).
   - The 3 existing `bun:test` files now actually run — verify they pass.
3. `src/app/api/scoring/stream/route.ts`: emit JSON SSE matching what `sidebar.tsx` consumes (currently plain text → dead `JSON.parse` branch); fix `__tests__/api/scoring/stream.test.ts` to mock `getNatsScoringConnection` (route's actual import) and assert the JSON payload.
4. `middleware.ts`: extend matcher to `/device/:path*` (parity with `/fleet/:path*`).
5. `.github/workflows/test-web-client.yml`: `oven-sh/setup-bun` + `bun install` + `bun run test` (and `bun run lint`).
6. Move `shadcn` to `devDependencies`; delete dead `ScoringAlerts.tsx` if unreferenced (verify).

Acceptance: `bun install && bun run test && bun run lint` green locally and in CI.

### G3 — Java chart service (F4–F13)

`websocket/TelemetryWebSocketHandler.java`:
- Cancel `info.pollTask()` in `afterConnectionClosed` and `handleTransportError`; add `@PreDestroy` `scheduler.shutdownNow()`.
- `handleUnsubscribe`: pass the *removed* columns to `unsubscribeLive`.
- Skip polling when `subscribedColumns` is empty; dedup by last-sent row key.
- Remove dead `broadcastLiveData()` and unused `lastPollTime` bookkeeping.

`service/TelemetryService.java`:
- Replace open-ended ranges with key-prefix regex `"^" + Pattern.quote(vehicleId) + "#.*"` (F7/F8); push `limit` into `Query.limit(...)` (drop post-hoc `subList`); keep documented half-open semantics and add 1ns to `endTime` for inclusive-end queries.
- `parseRow`: skip unparseable keys (log + warn) instead of fabricating `Instant.now()` (F9).
- Delete `liveSubscriptions` map + `subscribeLive`/`unsubscribeLive` (dead; F6).

`config/BigtableConfig.java`: delete; `TelemetryService` keeps its single client in `@PostConstruct` (one `System.setProperty` site) (F10).

`config/SecurityConfig.java` + `websocket/WebSocketConfig.java`: default-deny; allow `GET /api/v1/vehicles/**`, WS `/api/v1/vehicles/**/live`, `/actuator/health` (compose healthcheck); WS origins `http://localhost:3000` (+ `http://127.0.0.1:3000`); `show-details: when-authorized` (F11).

`web/TelemetryController.java`: `listVehicles()` derives distinct VINs from Bigtable (drop hardcoded list); catch `DateTimeParseException` → 400 (F12).

`resources/application.yml`: `server.port: ${SERVER_PORT:8080}`, INFO logging default (F13).

New unit test: `TelemetryServiceRowKeyTest` covering prefix-regex/end-key helpers (the F7/F8 bug class). Keep maven build green.

### G4 — Fresh-clone buildability (F14–F17)

1. `nats-bigtable-connector/Dockerfile.local`: delete the redundant `COPY api/gen/telemetry ./api/gen/telemetry/` (the `RUN protoc` generates it in-image).
2. `.gitignore`: after `**/.mvn/**` add `!**/.mvn/wrapper/` + `!**/.mvn/wrapper/*`; `git add` the `maven-wrapper.properties`.
3. `data-api-sampler/pom.xml`: remove logback/jakarta exclusions from dependencies and the spring-boot-maven-plugin `excludes` (keep lombok exclude).
4. `data-web-client/Dockerfile.local`: propagate `TELEMETRY_SERVICE_URL` ARG into the runner stage (`ARG` + `ENV`).

Acceptance: no Dockerfile references gitignored paths; `git ls-files` includes the wrapper properties; web runner stage receives the URL env.

### G5 — local-dev shell/compose (F18–F28)

1. `setup-automated.sh`: `base64 -b 0` → `base64 | tr -d '\n'` (F18); `--status exited` single value + `phase_verify` covers connector/chart-service/web-client (F20); honor the cleanup prompt answer + guard `read -p` with `[ -t 0 ]` (F24); after token injection, fail-fast if any placeholder seed remains in generated `.env.*` (F23).
2. `scripts/wait-for-services.sh`: accumulate failures, exit 1, drop `eval` (F19).
3. `Makefile` `clean`: remove `local-dev/certs/` (F21); `generate-certs.sh`: gate on the full expected-cert list, and remove partial `certs/` on generation failure (F21); delete the dead "test device" cert block signed by the wrong CA (F27); add `bash` to the cert-generator image (F26).
4. `nexus-realm.json`: `sslRequired` `"external"` → `"none"` (F22); `setup-automated.sh` JWKS fetch add `-L` (F22).
5. `configs/infra.template` + `configs/base-services.template`: replace live NKey seed/pub + real JWKS snapshot with obviously-invalid placeholders (F23).
6. `docker-compose.infra.yml`: remove dead NATS env block (F25); mosquitto ports → `127.0.0.1:1883:1883`, drop dead 8888/8883 publish, add `mosquitto-data` volume for `persistence true` (F28).
7. `docker-compose.certs.yml`: remove unused named `certs` volume (F26).

Acceptance: `bash -n` on all scripts; no `base64 -b`; templates contain no real key material; `make clean` removes certs.

### G6 — Docs (F30)

- `local-dev/README.md` / `ARCHITECTURE.md`: fix "no NATS→Bigtable writer", "make clean regenerates PKI", and smoke-test coverage claims.
- `data-web-client/docs/theming.md`: correct HSL → oklch description.

## 5. Verification

Static (run here): `bash -n` all shell changes; `bun install && bun run test && bun run lint` in `data-web-client`; `go build ./...` for touched Go modules (auth-callout untouched — verify no compile impact); `mvnw -q -DskipTests package` for chart service if network allows; `git ls-files` checks for the wrapper file; grep for removed stale phrases.

[runtime — offered to user after code lands]: `make clean && make go && make test && make vehicle-client` + frontend manual smoke (docker bring-up is 2–3 min; chart-service reversed-read + Keycloak service-account roles are the two runtime-verify items).

## 6. Out of scope

Branch renames/deletes; committing `AGENTS.md`, `docs/superpowers/research/`, `presentations/`; upstream sync; AAOS telemetry; predictive-maintenance work; UI redesigns beyond the listed fixes.

## 7. Risks

- Keycloak realm-import shape for service-account role assignment (mitigated: standard export format; runtime-verified in smoke).
- `bun test` has no jsdom by default — no DOM tests exist today; if added later, adopt `happy-dom` (noted in doc).
- Emulator `reversed()` read support — unchanged from current behavior (already in use); runtime-verified in smoke.
- Scope discipline: no refactors beyond listed items (e.g. auth-callout code intentionally untouched).
