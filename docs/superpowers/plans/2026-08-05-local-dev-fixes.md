# Local-Dev Fix Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 32 verified findings (G1–G6) from `docs/superpowers/specs/2026-08-05-local-dev-fixes-design.md` on branch `feat/local-dev-no-gcp`, leaving `main`/`origin/main` untouched.

**Architecture:** Five independent fix groups: (G1) per-VIN Keycloak client `VIN123` makes the existing `azp`-based auth-callout grant `telemetry.VIN123.>`; (G2) frontend data-path + test-infra fixes (bun test); (G3) Java chart-service lifecycle/query/security fixes; (G4) fresh-clone buildability; (G5) local-dev shell/compose hardening; (G6) doc corrections.

**Tech Stack:** bash, docker-compose, Keycloak 24 realm JSON, Go (untouched in G1 by design), Java 21/Spring Boot 3.5.16 (Maven, `mvnw`), Next.js 16 + bun 1.3.14 + React 19, Jest→bun test, GitHub Actions.

## Global Constraints

- Branch: `feat/local-dev-no-gcp` only. NEVER touch `main`/`origin/main` (user instruction).
- Bigtable filters use RE2 regex — `\Q...\E` (Java `Pattern.quote`) is NOT supported; escape manually.
- Config is env-driven; canonical env names in `local-dev/configs/*.template`.
- Web client: bun only (no npm); `bun.lock` committed; do not commit generated artifacts.
- Java: JDK 21, Spring Boot 3.5.16, Maven wrapper (`mvnw`); test deps exist, zero tests — add the one unit test this plan specifies.
- REST/WS public shapes (path, JSON fields) must NOT change — consumers (`data-web-client`, compose healthchecks) depend on them.
- Commit per task with conventional-commit messages matching repo style (`fix:`, `feat:`, `chore:`, `docs:`).
- Every task: skip project-wide test suites; run only the verification commands listed in the task.
- Files changed by multiple tasks: `use-telemetry-data.ts` (Tasks 4, 5), `Dockerfile.local` (web; Tasks 5, 11), `run-vehicle-client.sh` (Tasks 2, 3 context only), `test-local-flow.sh` (Task 3 only). Do tasks in order.

---

### Task 1: G1 — Add per-VIN `VIN123` Keycloak client with service-account roles

**Files:**
- Modify: `local-dev/keycloak/nexus-realm.json`

**Interfaces:**
- Produces: client `VIN123` (secret `vin123-secret`, service account enabled) + user `service-account-vin123` with `realmRoles: ["edge-device", "telemetry-client"]`. Consumed by Task 2 (client id default) and Task 3 (smoke flow). Auth-callout code is NOT touched (per design D1: `azp` = client id = VIN).

- [ ] **Step 1: Add the client to `clients[]`**

Insert after the `vehicle-client` client object (after line 68, before `data-api-sampler`):

```json
    {
      "clientId": "VIN123",
      "name": "Vehicle Client VIN123",
      "description": "Per-VIN confidential client; azp=VIN123 so auth-callout grants telemetry.VIN123.> and commands.VIN123.>",
      "rootUrl": "",
      "adminUrl": "",
      "baseUrl": "",
      "surrogateAuthRequired": false,
      "enabled": true,
      "alwaysDisplayInConsole": false,
      "clientAuthenticatorType": "client-secret",
      "secret": "vin123-secret",
      "redirectUris": ["*"],
      "webOrigins": ["*"],
      "notBefore": 0,
      "bearerOnly": false,
      "consentRequired": false,
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "serviceAccountsEnabled": true,
      "publicClient": false,
      "frontchannelLogout": false,
      "protocol": "openid-connect",
      "attributes": {
        "oauth2.device.authorization.grant.enabled": "false",
        "oidc.ciba.grant.enabled": "false",
        "client.secret.creation.time": "0"
      },
      "authenticationFlowBindingOverrides": {},
      "fullScopeAllowed": true,
      "nodeReRegistrationTimeout": -1,
      "protocolMappers": [
        {
          "name": "realm roles",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-realm-role-mapper",
          "consentRequired": false,
          "config": {
            "multivalued": "true",
            "userinfo.token.claim": "true",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "claim.name": "realm_access.roles",
            "jsonType.label": "String"
          }
        }
      ]
    },
```

- [ ] **Step 2: Add the service-account user to `users[]`**

In the `users` array, after the `test-device` entry, add:

```json
    {
      "username": "service-account-vin123",
      "enabled": true,
      "emailVerified": false,
      "serviceAccountClientId": "VIN123",
      "realmRoles": ["edge-device", "telemetry-client"]
    }
```

(Keycloak import auto-creates the service account when `serviceAccountsEnabled` is true; this entry is the standard realm-export shape that assigns it realm roles, which flow into `realm_access.roles` of `client_credentials` tokens. [runtime] confirm at Task 15 smoke.)

- [ ] **Step 3: Verify JSON validity and shape**

Run:
```bash
jq -e '.clients[] | select(.clientId=="VIN123") | .secret == "vin123-secret" and .serviceAccountsEnabled' local-dev/keycloak/nexus-realm.json
jq -e '.users[] | select(.username=="service-account-vin123") | .realmRoles == ["edge-device","telemetry-client"]' local-dev/keycloak/nexus-realm.json
```
Expected: both print `true` and exit 0.

- [ ] **Step 4: Commit**

```bash
git add local-dev/keycloak/nexus-realm.json
git commit -m "fix(local-dev): add per-VIN Keycloak client VIN123 with edge-device/telemetry-client roles"
```

---

### Task 2: G1 — Default the vehicle-client wrapper to the `VIN123` client

**Files:**
- Modify: `local-dev/scripts/run-vehicle-client.sh:95`

**Interfaces:**
- Consumes: client `VIN123` from Task 1 (secret auto-read via existing `jq` lookup at lines 96–101).
- Produces: `make vehicle-client` authenticates as `VIN123` → `azp=VIN123` → NATS perms `telemetry.VIN123.>` / `commands.VIN123.>`.

- [ ] **Step 1: Change the default client id**

Edit `local-dev/scripts/run-vehicle-client.sh:95`:

```bash
export KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-vehicle-client}"
```
→
```bash
export KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-VIN123}"
```

Also update the adjacent comment (line 90–93) so it no longer claims the local realm's client is `vehicle-client`; e.g. append: "Per-VIN clients (e.g. VIN123) make azp equal the VIN, which is what auth-callout grants NATS permissions on."

- [ ] **Step 2: Verify**

```bash
grep -n 'KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-VIN123}"' local-dev/scripts/run-vehicle-client.sh
bash -n local-dev/scripts/run-vehicle-client.sh
```
Expected: match + exit 0 (no syntax errors).

- [ ] **Step 3: Commit**

```bash
git add local-dev/scripts/run-vehicle-client.sh
git commit -m "fix(local-dev): default vehicle-client Keycloak client to per-VIN VIN123"
```

---

### Task 3: G1 — Smoke-test the vehicle flow end to end

**Files:**
- Modify: `local-dev/scripts/test-local-flow.sh`

**Interfaces:**
- Consumes: Task 2 wrapper (`bash scripts/run-vehicle-client.sh` publishes to `telemetry.VIN123.>`), stack services from `make go` (registration :8444, NATS :4222, Bigtable :8086).
- Produces: Test 5 asserts Bigtable row count under prefix `VIN123#` increases after a ~30s vehicle-client run. Also adds `telemetry-chart-service` + `data-web-client` to the Test 1 service list (F20) and replaces the stale skip notes.

- [ ] **Step 1: Confirm the vehicle-client default VIN**

Run:
```bash
grep -n 'flag.String\|VIN' sample-clients/vehicle-client/main.go | head -15
```
If the default VIN is not `VIN123`, export it in the smoke test instead (`VIN=VIN123 bash scripts/run-vehicle-client.sh ...` — the wrapper passes env through; verify the wrapper doesn't override VIN).

- [ ] **Step 2: Extend the Test 1 service list**

In `local-dev/scripts/test-local-flow.sh`, change the `for svc in ...` line (Test 1) to:

```bash
for svc in data-api data-converter auth-callout registration data-api-sampler trip-analyzer nats-bigtable-connector telemetry-chart-service data-web-client; do
```

- [ ] **Step 3: Replace the skip block with Test 5**

Replace the trailing block:

```bash
echo ""
skip "Full registration + Keycloak JWT + NATS publish: run 'make vehicle-client'"
skip "  (Keycloak X.509 client-auth is a documented gap - see local-dev/README.md)"
echo ""
```

with:

```bash
echo ""
log "Test 5: Vehicle flow (registration -> Keycloak JWT -> NATS publish -> Bigtable)"
if command -v go >/dev/null 2>&1 && command -v protoc >/dev/null 2>&1 \
   && command -v jq >/dev/null 2>&1 && command -v openssl >/dev/null 2>&1; then
    count_rows() {
        docker exec -e BIGTABLE_EMULATOR_HOST=localhost:8086 \
            nexus-bigtable-emulator cbt -project test-project -instance test-instance \
            read telemetry 2>/dev/null | grep -c "VIN123#"
    }
    before=$(count_rows || echo 0)
    log "  VIN123 rows before: $before"
    log "  starting vehicle-client (up to 35s for registration + first publish)..."
    VIN=${VIN:-VIN123} bash scripts/run-vehicle-client.sh >/tmp/vehicle-client-smoke.log 2>&1 &
    smoke_pid=$!
    sleep 35
    kill "$smoke_pid" 2>/dev/null || true
    pkill -f "vehicle-client/vehicle-client" 2>/dev/null || true
    wait "$smoke_pid" 2>/dev/null || true
    after=$(count_rows || echo 0)
    log "  VIN123 rows after: $after"
    if [ "$after" -gt "$before" ]; then
        log "  OK: vehicle flow published new telemetry rows"
    else
        fail "  vehicle flow produced no new rows (see /tmp/vehicle-client-smoke.log)"
        failed=1
    fi
else
    skip "  go/protoc/jq/openssl not all on PATH - skipping vehicle flow"
fi
echo ""
```

Update the final summary line's parenthetical from "(all health checks green; see SKIP notes above)" to "(all health checks green)".

- [ ] **Step 4: Update the file header comment**

Change the header comment (lines 3–5) to say the full vehicle flow is now exercised by Test 5 (client-secret flow via per-VIN client `VIN123`), and that X.509 cert-auth remains out of scope for local dev.

- [ ] **Step 5: Verify syntax**

```bash
bash -n local-dev/scripts/test-local-flow.sh
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add local-dev/scripts/test-local-flow.sh
git commit -m "feat(local-dev): smoke-test the full vehicle flow (registration+JWT+NATS+Bigtable)"
```

---

### Task 4: G2 — Fix `useTelemetryData.load()` discarding fetched data (F2)

**Files:**
- Modify: `sample-clients/data-web-client/src/hooks/use-telemetry-data.ts:35-47` (load)
- Test: `sample-clients/data-web-client/src/hooks/use-telemetry-data.test.ts` (extend)
- Create: `sample-clients/data-web-client/bunfig.toml` (test preload for DOM)
- Modify: `sample-clients/data-web-client/test/dom-preload.ts` (repurpose: happy-dom globals)

**Interfaces:**
- Produces: `useTelemetryData` stores fetched historical series in `series` state; retry (`refetch`) and compare-VIN overlays now work. Consumed by `src/app/device/[id]/page.tsx` (unchanged callers).

- [ ] **Step 1: Write the failing regression test**

Append to `src/hooks/use-telemetry-data.test.ts`:

```ts
import { describe, expect, it, mock } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { useTelemetryData } from '@/hooks/use-telemetry-data';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {}
  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }
}
// @ts-expect-error minimal stub for test env
globalThis.WebSocket = FakeWebSocket;

const mockFetch = mock(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        rows: [
          { timestamp: '2026-08-05T00:00:00.000000000Z', values: { 'dynamic:speed': '42' } },
        ],
        columns: ['dynamic:speed'],
      }),
  })
);
// @ts-expect-error minimal stub for test env
globalThis.fetch = mockFetch;

describe('useTelemetryData', () => {
  it('stores fetched historical data in series (regression: load() discarded it)', async () => {
    const { result } = renderHook(() => useTelemetryData({ vin: 'VIN123', range: '1h' }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.series).toHaveLength(1);
    expect(result.current.series[0].column).toBe('dynamic:speed');
    expect(result.current.series[0].points[0]?.y).toBe(42);
    expect(mockFetch).toHaveBeenCalled();
  });
});
```

Create `bunfig.toml` in `sample-clients/data-web-client/`:

```toml
[test]
preload = ["./test/dom-preload.ts"]
```

Replace `test/dom-preload.ts` contents with:

```ts
// Registers happy-dom globals so @testing-library/react works under `bun test`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `cd sample-clients/data-web-client && bun test src/hooks/use-telemetry-data.test.ts`
Expected: FAIL — `series` stays `[]`, `waitFor` times out (the bug: `load()` computes `all` and never calls `setSeries`).

- [ ] **Step 3: Fix `load()`**

In `src/hooks/use-telemetry-data.ts`, replace:

```ts
      const all = (await Promise.all(vins.map((v, i) => fetchHistorical(v, i)))).flat();
    } catch (e) {
```

with:

```ts
      const all = (await Promise.all(vins.map((v, i) => fetchHistorical(v, i)))).flat();
      setSeries(all);
    } catch (e) {
```

- [ ] **Step 4: Add happy-dom devDependency**

Run: `cd sample-clients/data-web-client && bun add -d happy-dom`
(Updates `package.json` + `bun.lock`.)

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `cd sample-clients/data-web-client && bun test src/hooks/use-telemetry-data.test.ts`
Expected: PASS (2 tests: existing `shapeRows` + new hook test).

- [ ] **Step 6: Commit**

```bash
git add sample-clients/data-web-client/src/hooks/use-telemetry-data.ts sample-clients/data-web-client/src/hooks/use-telemetry-data.test.ts sample-clients/data-web-client/bunfig.toml sample-clients/data-web-client/test/dom-preload.ts sample-clients/data-web-client/package.json sample-clients/data-web-client/bun.lock
git commit -m "fix(web): store fetched historical telemetry in hook state (load() discarded it)"
```

---

### Task 5: G2 — WS URL env override + Dockerfile/compose wiring (F17)

**Files:**
- Modify: `sample-clients/data-web-client/src/hooks/use-telemetry-data.ts:90-91`
- Modify: `sample-clients/data-web-client/Dockerfile.local`
- Modify: `local-dev/docker-compose.yml` (web-client build args, ~line 137-141)

**Interfaces:**
- Produces: browser WS base from `NEXT_PUBLIC_TELEMETRY_SERVICE_URL` (default `http(s)://<hostname>:8081` — current behavior preserved); runner stage of the web image gets `TELEMETRY_SERVICE_URL` env for the server-side proxy (`src/app/api/telemetry/[vin]/route.ts`).

- [ ] **Step 1: Read env in the hook**

Replace in `src/hooks/use-telemetry-data.ts`:

```ts
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.hostname}:8081/api/v1/vehicles/${encodeURIComponent(vin)}/telemetry/live`);
```

with:

```ts
    const configured = process.env.NEXT_PUBLIC_TELEMETRY_SERVICE_URL;
    const base =
      configured ??
      `http${window.location.protocol === 'https:' ? 's' : ''}://${window.location.hostname}:8081`;
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/vehicles/${encodeURIComponent(vin)}/telemetry/live`);
```

- [ ] **Step 2: Fix the web Dockerfile env propagation**

In `Dockerfile.local` builder stage, replace:

```dockerfile
ARG TELEMETRY_SERVICE_URL
ENV TELEMETRY_SERVICE_URL=${TELEMETRY_SERVICE_URL}
ENV NEXT_PUBLIC_TELEMETRY_SERVICE_URL=${TELEMETRY_SERVICE_URL}
```

with:

```dockerfile
ARG TELEMETRY_SERVICE_URL
ENV TELEMETRY_SERVICE_URL=${TELEMETRY_SERVICE_URL}
ARG NEXT_PUBLIC_TELEMETRY_SERVICE_URL
ENV NEXT_PUBLIC_TELEMETRY_SERVICE_URL=${NEXT_PUBLIC_TELEMETRY_SERVICE_URL:-http://localhost:8081}
```

In the runner stage, after `ENV NODE_ENV=production`, add:

```dockerfile
ARG TELEMETRY_SERVICE_URL
ENV TELEMETRY_SERVICE_URL=${TELEMETRY_SERVICE_URL}
```

- [ ] **Step 3: Pass both args from compose**

In `local-dev/docker-compose.yml`, the `data-web-client` build block currently has:

```yaml
      args:
        TELEMETRY_SERVICE_URL: http://telemetry-chart-service:8080
```

Replace with:

```yaml
      args:
        TELEMETRY_SERVICE_URL: http://telemetry-chart-service:8080
        NEXT_PUBLIC_TELEMETRY_SERVICE_URL: http://localhost:8081
```

- [ ] **Step 4: Verify**

```bash
grep -n 'NEXT_PUBLIC_TELEMETRY_SERVICE_URL' sample-clients/data-web-client/src/hooks/use-telemetry-data.ts sample-clients/data-web-client/Dockerfile.local local-dev/docker-compose.yml
bash -n sample-clients/data-web-client/Dockerfile.local 2>/dev/null || docker buildx build --check -f sample-clients/data-web-client/Dockerfile.local sample-clients/data-web-client
```
Expected: 3 matches (hook, Dockerfile builder+runner = 2, compose) and no syntax errors.

- [ ] **Step 5: Commit**

```bash
git add sample-clients/data-web-client/src/hooks/use-telemetry-data.ts sample-clients/data-web-client/Dockerfile.local local-dev/docker-compose.yml
git commit -m "fix(web): env-driven telemetry WS URL and runner-stage TELEMETRY_SERVICE_URL"
```

---

### Task 6: G2 — Migrate web-client tests to `bun test` (F3)

**Files:**
- Modify: `sample-clients/data-web-client/package.json`
- Delete: `sample-clients/data-web-client/jest.config.ts`, `jest.setup.ts`, `package-lock.json`
- (test/dom-preload.ts was repurposed in Task 4 — keep.)

**Interfaces:**
- Produces: `bun run test` runs every `*.test.ts` (src/** and __tests__/**) — jest `testMatch` limitation gone. Consumed by Task 7 (rewritten SSE test) and Task 15 (final verification) and the CI workflow (Task 7).

- [ ] **Step 1: Edit package.json**

- `scripts.test`: `"jest --forceExit"` → `"bun test"`
- Move `shadcn` from `dependencies` to `devDependencies` (F31).
- Remove from `devDependencies`: `jest`, `jest-environment-jsdom`, `ts-node`, `@types/jest`, `@testing-library/jest-dom` (keep `@testing-library/react`, `@testing-library/user-event`, `@testing-library/dom` if present — they are bun-compatible).

- [ ] **Step 2: Delete obsolete jest files**

```bash
rm sample-clients/data-web-client/jest.config.ts sample-clients/data-web-client/jest.setup.ts sample-clients/data-web-client/package-lock.json
```

- [ ] **Step 3: Reinstall + run full suite**

Run: `cd sample-clients/data-web-client && bun install && bun run test`
Expected: all tests pass, including the pre-existing `__tests__/lib/telemetry-chart-utils.test.ts` (bun-native) and `src/lib/register-chart.test.ts`. If `__tests__/api/scoring/stream.test.ts` fails (it mocks jest globals), that is expected — Task 7 rewrites it; verify only that the OTHER files pass and note the one red file.

- [ ] **Step 4: Lint check**

Run: `cd sample-clients/data-web-client && bun run lint`
Expected: exit 0. If lint fails on pre-existing code unrelated to this task, record the failures and continue (no new failures introduced by this task).

- [ ] **Step 5: Commit**

```bash
git add sample-clients/data-web-client/package.json sample-clients/data-web-client/bun.lock
git add -u sample-clients/data-web-client
git rm -q sample-clients/data-web-client/jest.config.ts sample-clients/data-web-client/jest.setup.ts sample-clients/data-web-client/package-lock.json
git commit -m "chore(web): migrate tests to bun test (remove jest infra)"
```

---

### Task 7: G2 — SSE JSON contract, stale test rewrite, middleware, CI (F29, F31)

**Files:**
- Modify: `sample-clients/data-web-client/src/app/api/scoring/stream/route.ts`
- Rewrite: `sample-clients/data-web-client/__tests__/api/scoring/stream.test.ts`
- Modify: `sample-clients/data-web-client/middleware.ts`
- Delete: `sample-clients/data-web-client/src/components/ScoringAlerts.tsx` (verify unreferenced first)
- Create: `.github/workflows/test-web-client.yml`

**Interfaces:**
- Produces: SSE payload contract `data: {"vehicle":"...","score":"...","message":"..."}` — matches `sidebar.tsx`'s existing `JSON.parse` destructure `{ vehicle, score, message }` (line 46); middleware now guards `/device/*`; CI runs web tests.
- Consumes: Task 6 (`bun test` works).

- [ ] **Step 1: Verify ScoringAlerts.tsx is unreferenced**

```bash
grep -rn "ScoringAlerts" sample-clients/data-web-client/src sample-clients/data-web-client/__tests__ --include='*.ts' --include='*.tsx'
```
Expected: only the component file itself. If referenced anywhere, keep the file and note it.

- [ ] **Step 2: Emit JSON in the SSE route**

In `src/app/api/scoring/stream/route.ts`, replace:

```ts
            const text = `${vehicleId} - ${score} - ${suggestions.join(', ')}`;
            controller.enqueue(encoder.encode(`data: ${text}\n\n`));
```

with:

```ts
            const payload = JSON.stringify({
              vehicle: vehicleId,
              score,
              message: suggestions.join(', '),
            });
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
```

Also delete the two noisy per-message `console.log` lines ("[/api/scoring/stream] NATS connected..." and "[/api/scoring/stream] Received NATS message...").

- [ ] **Step 3: Rewrite the stale test for bun**

Replace `__tests__/api/scoring/stream.test.ts` entirely with:

```ts
import { describe, expect, it, mock } from 'bun:test';
import protobuf from 'protobufjs';

const SCORING_PROTO = `
  syntax = "proto3";
  package scoring;
  message ScoringMessage {
    string vehicle_id = 1;
    string score = 2;
    repeated string suggestions = 3;
  }
`;

const root = protobuf.parse(SCORING_PROTO).root;
const ScoringMessage = root.lookupType('scoring.ScoringMessage');

const mockGetServerSession = mock(() => null);
let subStub: {
  [Symbol.asyncIterator]: () => AsyncGenerator<{ data: Uint8Array }>;
  unsubscribe: () => void;
};

mock.module('next-auth', () => ({
  getServerSession: (args: unknown) => mockGetServerSession(args),
}));
mock.module('@/lib/auth', () => ({ authOptions: {} }));
mock.module('@/lib/nats', () => ({
  getNatsScoringConnection: () =>
    Promise.resolve({ subscribe: () => subStub }),
}));

const { GET } = await import('@/app/api/scoring/stream/route');

function makeAbortableRequest(): Request {
  const controller = new AbortController();
  return new Request('http://localhost/api/scoring/stream', { signal: controller.signal });
}

async function* makeMessages(payloads: Uint8Array[]): AsyncGenerator<{ data: Uint8Array }> {
  for (const p of payloads) {
    yield { data: p };
  }
}

function scoringPayload(vehicleId: string, score: string, suggestions: string[]): Uint8Array {
  return ScoringMessage.encode({ vehicleId, score, suggestions }).finish() as unknown as Uint8Array;
}

describe('GET /api/scoring/stream', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const res = await GET(makeAbortableRequest());
    expect(res.status).toBe(401);
  });

  it('returns SSE response with correct headers when authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { name: 'test' } });
    subStub = {
      [Symbol.asyncIterator]: () => makeMessages([]),
      unsubscribe: () => {},
    };
    const res = await GET(makeAbortableRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('streams decoded NATS messages as JSON SSE events', async () => {
    mockGetServerSession.mockResolvedValueOnce({ user: { name: 'test' } });
    subStub = {
      [Symbol.asyncIterator]: () =>
        makeMessages([scoringPayload('VIN123', '8.5', ['a', 'b'])]),
      unsubscribe: () => {},
    };
    const res = await GET(makeAbortableRequest());
    const text = await res.text();
    expect(text).toContain('data: {"vehicle":"VIN123","score":"8.5","message":"a, b"}\n\n');
  });
});
```

- [ ] **Step 4: Extend the middleware matcher**

In `middleware.ts`, replace:

```ts
  matcher: ['/fleet/:path*'],
```

with:

```ts
  matcher: ['/fleet/:path*', '/device/:path*'],
```

- [ ] **Step 5: Delete the dead component**

```bash
git rm -q sample-clients/data-web-client/src/components/ScoringAlerts.tsx
```

- [ ] **Step 6: Add the CI workflow**

Create `.github/workflows/test-web-client.yml`:

```yaml
name: test-web-client

on:
  push:
    paths:
      - 'sample-clients/data-web-client/**'
      - '.github/workflows/test-web-client.yml'
  pull_request:
    paths:
      - 'sample-clients/data-web-client/**'

jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: sample-clients/data-web-client
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - run: bun install --frozen-lockfile
      - run: bun run test
      - run: bun run lint
```

- [ ] **Step 7: Verify**

Run: `cd sample-clients/data-web-client && bun run test && bun run lint`
Expected: all tests pass (including the rewritten SSE test — the JSON assertion requires the Task 7 route change), lint exit 0.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/test-web-client.yml sample-clients/data-web-client/src/app/api/scoring/stream/route.ts sample-clients/data-web-client/__tests__/api/scoring/stream.test.ts sample-clients/data-web-client/middleware.ts
git commit -m "fix(web): JSON SSE scoring payload, bun-native stream test, /device auth matcher, CI job"
```

---

### Task 8: G3 — WebSocket handler lifecycle (F4, F5, F6)

**Files:**
- Modify: `sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/websocket/TelemetryWebSocketHandler.java`

**Interfaces:**
- Consumes: Task 9 removes `TelemetryService.subscribeLive/unsubscribeLive` — this task must drop those calls at the same time (do NOT leave dangling calls).
- Produces: per-session poll task cancelled on close/error; scheduler shut down on bean destroy; unsubscribe mutates only the session's own set; poll skips empty subscriptions; no duplicate pushes of the same row.

- [ ] **Step 1: Add imports and `@PreDestroy` shutdown**

Add import `jakarta.annotation.PreDestroy`. Remove the now-unused `java.time.Instant` import (lastPollTime removed in Step 4).

- [ ] **Step 2: Drop the dead `subscribeLive`/`unsubscribeLive` calls**

- In `afterConnectionEstablished`: remove the block:
```java
        // Subscribe to live updates
        telemetryService.subscribeLive(vin, info.subscribedColumns());
```
- In `handleSubscribe`: remove `telemetryService.subscribeLive(info.vin(), info.subscribedColumns());`
- In `handleUnsubscribe`: remove `telemetryService.unsubscribeLive(info.vin(), info.subscribedColumns());`
- In `afterConnectionClosed`: remove `telemetryService.unsubscribeLive(info.vin(), info.subscribedColumns());`

`handleSubscribe` and `handleUnsubscribe` then only mutate `info.subscribedColumns()` (and ack in subscribe).

- [ ] **Step 3: Fix lifecycle — cancel + shutdown**

Add at the end of the class:

```java
    @PreDestroy
    public void shutdown() {
        scheduler.shutdownNow();
        sessions.values().forEach(this::cancelPoll);
    }

    private void cancelPoll(SessionInfo info) {
        ScheduledFuture<?> task = info.pollTask();
        if (task != null) {
            task.cancel(false);
            info.pollTask(null);
        }
    }
```

In `afterConnectionClosed`, add `cancelPoll(info);` before the log line. In `handleTransportError`, add:

```java
        cancelPoll(sessions.get(session.getId()));
```

- [ ] **Step 4: Poll only with subscriptions; dedup identical rows**

In `startPolling`'s runnable, at the top add:

```java
                if (info.subscribedColumns().isEmpty()) {
                    return;
                }
```

and after `point` is obtained, before building the message:

```java
                String pointKey = point.timestamp().toString();
                if (pointKey.equals(info.lastSentTimestamp())) {
                    return;
                }
                info.lastSentTimestamp(pointKey);
```

In `SessionInfo`, replace `lastPollTime` with `lastSentTimestamp`:

```java
        private volatile String lastSentTimestamp;
```
(remove the `Instant.now()` initializer and the `lastPollTime` accessors; add `public String lastSentTimestamp() { return lastSentTimestamp; }` and `public void lastSentTimestamp(String v) { this.lastSentTimestamp = v; }`).

- [ ] **Step 5: Remove the empty `broadcastLiveData()` method**

Delete the method and its comment.

- [ ] **Step 6: Verify compilation**

Run: `cd sample-services/telemetry-chart-service && ./mvnw -q -DskipTests compile`
Expected: BUILD SUCCESS. (If Maven Central is unreachable, retry with `mvn -q -DskipTests compile` and note the environment; the Docker build uses the same pom.)

- [ ] **Step 7: Commit**

```bash
git add sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/websocket/TelemetryWebSocketHandler.java
git commit -m "fix(chart-service): cancel WS poll tasks on close, shutdown scheduler, fix unsubscribe semantics"
```

---

### Task 9: G3 — TelemetryService query correctness (F7, F8, F9, F10)

**Files:**
- Modify: `sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/service/TelemetryService.java`
- Delete: `sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/config/BigtableConfig.java`
- Create: `sample-services/telemetry-chart-service/src/test/java/com/nexus/sdv/telemetrychartservice/service/TelemetryServiceRowKeyTest.java`

**Interfaces:**
- Consumes: Task 8 removed all `subscribeLive`/`unsubscribeLive` callers — this task deletes those methods.
- Produces: `queryTelemetry(vehicleId, startTime, endTime, columns, limit)` (new `limit` param), `listVehicles()`, package-private statics `vehicleKeyRegex(String)`, `escapeRegex(String)`, `buildRowKey(String, Instant)` (changed visibility), `buildEndKeyInclusive(String, Instant)` — consumed by the controller (Task 10) and the unit test below.

- [ ] **Step 1: Delete `BigtableConfig.java`**

```bash
git rm -q sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/config/BigtableConfig.java
```
(TelemetryService keeps its own single client in `@PostConstruct` — remove the duplicate admin client there too.)

- [ ] **Step 2: Key helpers + escape for RE2**

In `TelemetryService`, change `buildRowKey` from `private` to package-private `static`, and add:

```java
    /**
     * RE2-safe regex escape (Bigtable filters do NOT support Java's \Q...\E).
     */
    static String escapeRegex(String input) {
        return input.replaceAll("([.^$*+?()\\[\\]{}|\\\\-])", "\\\\$1");
    }

    /**
     * Key regex matching exactly this vehicle's rows (VIN#...), never
     * sibling-prefixed VINs like VIN123-... or VIN1230#... .
     */
    static String vehicleKeyRegex(String vehicleId) {
        return "^" + escapeRegex(vehicleId) + "#.*";
    }

    /**
     * Exclusive end key that includes the exact end instant:
     * Bigtable ranges are half-open [start, end).
     */
    static String buildEndKeyInclusive(String vehicleId, Instant endTime) {
        return buildRowKey(vehicleId, endTime.plusNanos(1));
    }
```

- [ ] **Step 3: Query with prefix filter, limit, inclusive end**

Change `queryTelemetry` signature to add `int limit`:

```java
    public List<TelemetryPoint> queryTelemetry(String vehicleId, Instant startTime, Instant endTime,
                                               List<String> columns, int limit) {
        Query query = Query.create(tableId)
                .range(buildRowKey(vehicleId, startTime), buildEndKeyInclusive(vehicleId, endTime))
                .filter(Filters.FILTERS.chain()
                        .filter(Filters.FILTERS.key().regex(vehicleKeyRegex(vehicleId)))
                        .filter(buildColumnFilter(columns)))
                .limit(limit);
```

Keep the existing `results.sort(...)` (Bigtable returns rows in key order, but the sort is harmless and keeps the contract explicit). Keep the try/catch as-is.

- [ ] **Step 4: `getLatestTelemetry` with prefix range**

Replace the key/range construction:

```java
        String startKey = vehicleId + "#";
        String endKey = vehicleId + "0"; // Lexicographically after all timestamps

        Query query = Query.create(tableId)
                .range(startKey, endKey)
                .filter(buildColumnFilter(columns))
                .limit(1)
                .reversed(true);
```

with:

```java
        Query query = Query.create(tableId)
                .range(vehicleId + "#", vehicleId + "#\uffff")
                .filter(Filters.FILTERS.chain()
                        .filter(Filters.FILTERS.key().regex(vehicleKeyRegex(vehicleId)))
                        .filter(buildColumnFilter(columns)))
                .limit(1)
                .reversed(true);
```

- [ ] **Step 5: `parseRow` skips unparseable keys**

Replace the timestamp extraction block:

```java
        Instant timestamp = Instant.now();
        if (matcher.matches()) {
            String tsStr = matcher.group(2);
            try {
                timestamp = Instant.parse(tsStr);
            } catch (Exception e) {
                log.warn("Failed to parse timestamp from row key: {}", rowKey);
            }
        }
```

with:

```java
        if (!matcher.matches()) {
            log.warn("Skipping row with unparseable key (no VIN#timestamp shape): {}", rowKey);
            return null;
        }
        Instant timestamp;
        try {
            timestamp = Instant.parse(matcher.group(2));
        } catch (Exception e) {
            log.warn("Skipping row with unparseable timestamp in key {}: {}", rowKey, e.getMessage());
            return null;
        }
```

- [ ] **Step 6: Fix the column filter (AND per family, bare qualifier defaults to dynamic)**

Replace `buildColumnFilter` with:

```java
    private Filters.Filter buildColumnFilter(List<String> columns) {
        if (columns == null || columns.isEmpty()) {
            return Filters.FILTERS.pass();
        }

        Map<String, Set<String>> familyToQualifiers = new HashMap<>();
        for (String col : columns) {
            String[] parts = col.split(":", 2);
            String family = parts.length == 2 ? parts[0] : "dynamic";
            String qualifier = parts[parts.length - 1];
            familyToQualifiers.computeIfAbsent(family, k -> new HashSet<>()).add(qualifier);
        }

        List<Filters.Filter> chains = new ArrayList<>();
        for (Map.Entry<String, Set<String>> entry : familyToQualifiers.entrySet()) {
            String qualifierRegex = "^(" + entry.getValue().stream()
                    .map(TelemetryService::escapeRegex)
                    .collect(Collectors.joining("|")) + ")$";
            chains.add(Filters.FILTERS.chain()
                    .filter(Filters.FILTERS.family().exactMatch(entry.getKey()))
                    .filter(Filters.FILTERS.qualifier().regex(qualifierRegex)));
        }

        if (chains.size() == 1) {
            return chains.get(0);
        }
        Filters.InterleaveFilter interleave = Filters.FILTERS.interleave();
        for (Filters.Filter chain : chains) {
            interleave.filter(chain);
        }
        return interleave;
    }
```

- [ ] **Step 7: Remove live-subscription bookkeeping + admin client**

Delete `liveSubscriptions` field, `subscribeLive`, `unsubscribeLive`, `getLiveSubscriptions`, the `adminClient` field + its creation in `init()` + close in `close()`, and the now-unused imports (`BigtableTableAdminClient`, `BigtableTableAdminSettings`, `ConcurrentHashMap`).

- [ ] **Step 8: Add `listVehicles()`**

```java
    public List<String> listVehicles() {
        Set<String> vins = new TreeSet<>();
        Query query = Query.create(tableId)
                .filter(Filters.FILTERS.key().regex("^[^#]+#.*"))
                .limit(1000);
        try {
            dataClient.readRows(query).forEach(row -> {
                String key = row.getKey().toStringUtf8();
                int hash = key.indexOf('#');
                if (hash > 0) {
                    vins.add(key.substring(0, hash));
                }
            });
        } catch (Exception e) {
            log.error("Error listing vehicles", e);
        }
        return new ArrayList<>(vins);
    }
```

- [ ] **Step 9: Write the unit test**

Create `src/test/java/com/nexus/sdv/telemetrychartservice/service/TelemetryServiceRowKeyTest.java`:

```java
package com.nexus.sdv.telemetrychartservice.service;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;

class TelemetryServiceRowKeyTest {

    @Test
    void vehicleKeyRegexMatchesOnlyOwnPrefix() {
        Pattern p = Pattern.compile(TelemetryService.vehicleKeyRegex("VIN123"));
        assertTrue(p.matcher("VIN123#2026-08-05T00:00:00.000000000Z").matches());
        assertFalse(p.matcher("VIN1230#2026-08-05T00:00:00.000000000Z").matches());
        assertFalse(p.matcher("VIN123-OTHER#2026-08-05T00:00:00.000000000Z").matches());
        assertFalse(p.matcher("VIN12#2026-08-05T00:00:00.000000000Z").matches());
    }

    @Test
    void escapeRegexHandlesRegexMetacharacters() {
        assertEquals("VIN123", TelemetryService.escapeRegex("VIN123"));
        assertFalse(Pattern.compile(TelemetryService.escapeRegex("VIN.123"))
                .matcher("VINX123").matches());
        assertTrue(Pattern.compile(TelemetryService.escapeRegex("VIN.123"))
                .matcher("VIN.123").matches());
    }

    @Test
    void inclusiveEndKeyIsStrictlyAfterExactEndInstant() {
        Instant end = Instant.parse("2026-08-05T00:00:00.123456789Z");
        String endKey = TelemetryService.buildEndKeyInclusive("VIN123", end);
        String exact = TelemetryService.buildRowKey("VIN123", end);
        assertTrue(endKey.compareTo(exact) > 0);
    }
}
```

- [ ] **Step 10: Verify compile + tests**

Run: `cd sample-services/telemetry-chart-service && ./mvnw -q test -Dtest=TelemetryServiceRowKeyTest`
Expected: BUILD SUCCESS, 3 tests pass.

- [ ] **Step 11: Commit**

```bash
git add sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/service/TelemetryService.java sample-services/telemetry-chart-service/src/test/java/com/nexus/sdv/telemetrychartservice/service/TelemetryServiceRowKeyTest.java
git commit -m "fix(chart-service): prefix-scoped Bigtable queries, limit push-down, strict row-key parsing, single client"
```

---

### Task 10: G3 — Security default-deny, env config, controller (F11, F12, F13)

**Files:**
- Modify: `.../config/SecurityConfig.java`
- Modify: `.../websocket/WebSocketConfig.java`
- Modify: `.../web/TelemetryController.java`
- Modify: `.../resources/application.yml`

**Interfaces:**
- Consumes: `TelemetryService.queryTelemetry(..., int limit)` + `listVehicles()` from Task 9.
- Produces: same REST/WS paths, now default-deny; `listVehicles` returns real VINs; 400 on bad timestamps.

- [ ] **Step 1: SecurityConfig default-deny**

Replace the `authorizeHttpRequests` block with:

```java
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/actuator/health").permitAll()
                        .requestMatchers(org.springframework.http.HttpMethod.GET, "/api/v1/vehicles/**").permitAll()
                        .anyRequest().denyAll()
                )
```

Remove the now-dead `requestMatchers("/websocket/**")` line (the real WS path `/api/v1/vehicles/{vin}/telemetry/live` is covered by the GET matcher). Keep csrf disable + frameOptions + basic/form login disable.

- [ ] **Step 2: WebSocketConfig origins**

Replace:

```java
                .setAllowedOrigins("*");
```

with:

```java
                .setAllowedOrigins("http://localhost:3000", "http://127.0.0.1:3000");
```

- [ ] **Step 3: Controller — real VIN list, 400 on bad dates, clamped limit**

Replace `listVehicles` body with:

```java
    public List<String> listVehicles() {
        return telemetryService.listVehicles();
    }
```

In `getTelemetry`, replace the parameter handling and truncation:

```java
        int safeLimit = Math.max(1, Math.min(limit, 1000));
        ...
        List<TelemetryService.TelemetryPoint> points = telemetryService.queryTelemetry(
                vin, startTime, endTime, columnList, safeLimit);
```

(remove the `points.size() > limit` subList block) and add at the end of the class:

```java
    @org.springframework.web.bind.annotation.ExceptionHandler(java.time.format.DateTimeParseException.class)
    public ResponseEntity<String> handleBadTimestamp(java.time.format.DateTimeParseException e) {
        return ResponseEntity.badRequest().body("Invalid start/end timestamp (expected ISO-8601): " + e.getMessage());
    }
```

Add imports `org.springframework.http.ResponseEntity`. Also apply the same safeLimit clamp in `getLatestTelemetry` (columns only — no limit param there; leave as-is).

- [ ] **Step 4: application.yml env-driven + sane defaults**

Replace:

```yaml
server:
  port: 8080
```

with:

```yaml
server:
  port: ${SERVER_PORT:8080}
```

Replace `show-details: always` with `show-details: when-authorized`. Replace the logging block with:

```yaml
logging:
  level:
    com.nexus.sdv.telemetrychartservice: INFO
    com.google.cloud.bigtable: INFO
```

- [ ] **Step 5: Verify compile**

Run: `cd sample-services/telemetry-chart-service && ./mvnw -q -DskipTests compile`
Expected: BUILD SUCCESS. Confirm the compose healthcheck for the chart service (if any) targets `/actuator/health` — grep `local-dev/docker-compose.yml` for `telemetry-chart-service` healthcheck; if it hits `/actuator/health`, it stays permitted.

- [ ] **Step 6: Commit**

```bash
git add sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/config/SecurityConfig.java sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/websocket/WebSocketConfig.java sample-services/telemetry-chart-service/src/main/java/com/nexus/sdv/telemetrychartservice/web/TelemetryController.java sample-services/telemetry-chart-service/src/main/resources/application.yml
git commit -m "fix(chart-service): default-deny security, WS origin allowlist, derived VIN list, 400 on bad timestamps"
```

---

### Task 11: G4 — Fresh-clone buildability (F14, F15, F16)

**Files:**
- Modify: `base-services/nats-bigtable-connector/Dockerfile.local:23`
- Modify: `.gitignore` (after line 57 `**/.mvn/**`)
- Create (tracked): `sample-services/telemetry-chart-service/.mvn/wrapper/maven-wrapper.properties` (exists on disk; add to git)
- Modify: `sample-services/data-api-sampler/pom.xml`

**Interfaces:**
- Produces: `git clone` → `docker compose build` succeeds for the connector; `./mvnw` works in telemetry-chart-service; sampler image has a logging backend.

- [ ] **Step 1: Remove the redundant COPY in the connector Dockerfile**

Delete from `base-services/nats-bigtable-connector/Dockerfile.local`:

```dockerfile
# Copy generated protobuf code
COPY api/gen/telemetry ./api/gen/telemetry/
```

(the `RUN protoc` two steps above generates these files in-image; the COPY pulls a gitignored host dir and fails on fresh clones).

- [ ] **Step 2: Track the Maven wrapper properties**

Add to `.gitignore` after `**/.mvn/**`:

```gitignore
!**/.mvn/wrapper/
!**/.mvn/wrapper/*
```

Then:

```bash
git add .gitignore sample-services/telemetry-chart-service/.mvn/wrapper/maven-wrapper.properties
```

- [ ] **Step 3: Remove logback/jakarta exclusions from the sampler pom**

In `sample-services/data-api-sampler/pom.xml`:
- Remove the `<exclusions>` block (lines 46–58) from the `spring-boot-starter-actuator` dependency entirely (logback-core, logback-classic, jakarta.annotation-api exclusions — all ineffective: logback still arrives via `spring-boot-starter-logging`).
- Remove from `spring-boot-maven-plugin` `<excludes>` the `logback-classic` `<exclude>` block (keep the lombok exclude).

- [ ] **Step 4: Verify**

```bash
grep -n 'api/gen/telemetry' base-services/nats-bigtable-connector/Dockerfile.local || echo "COPY removed"
git ls-files sample-services/telemetry-chart-service/.mvn/wrapper
grep -n 'logback\|jakarta.annotation' sample-services/data-api-sampler/pom.xml || echo "exclusions removed"
```
Expected: "COPY removed" (or no match), wrapper properties listed, no logback/jakarta matches.

- [ ] **Step 5: Commit**

```bash
git add base-services/nats-bigtable-connector/Dockerfile.local .gitignore sample-services/telemetry-chart-service/.mvn/wrapper/maven-wrapper.properties sample-services/data-api-sampler/pom.xml
git commit -m "fix: fresh-clone buildability (connector COPY, maven wrapper, sampler logging backend)"
```

---

### Task 12: G5a — setup-automated.sh + compose hardening (F18, F20, F22, F24, F25, F26, F28)

**Files:**
- Modify: `local-dev/setup-automated.sh`
- Modify: `local-dev/docker-compose.infra.yml`
- Modify: `local-dev/docker-compose.certs.yml`
- Modify: `local-dev/config/mosquitto.conf` (only if the persistence volume requires it — Step 4 covers it)
- Modify: `local-dev/keycloak/nexus-realm.json` (`sslRequired`)

**Interfaces:**
- Produces: portable shell (Linux/macOS), honest exit codes, real coverage of the 3 missing services, no dead compose config, LAN-closed MQTT.

- [ ] **Step 1: Portable base64 + JWKS redirects (F18, F22)**

In `phase_keycloak_jwks`, replace:

```bash
        if curl -sf "$jwks_url" > certs/keycloak/jwks.json 2>/dev/null; then
```
with:
```bash
        if curl -sfL "$jwks_url" > certs/keycloak/jwks.json 2>/dev/null; then
```

Replace:
```bash
    jwks_b64=$(cat certs/keycloak/jwks.json | base64 -b 0)
```
with:
```bash
    jwks_b64=$(base64 < certs/keycloak/jwks.json | tr -d '\n')
```

- [ ] **Step 2: Honest crash check (F20)**

In `phase_app_startup`, replace:

```bash
    crashed="$(compose_app ps -a --status exited --status dead --services 2>/dev/null || true)"
```
with:
```bash
    crashed="$(compose_app ps -a --status exited --services 2>/dev/null || true)"
```

In `phase_verify`, replace the service list:

```bash
    for svc in data-api data-converter auth-callout registration data-api-sampler trip-analyzer; do
```
with:
```bash
    for svc in data-api data-converter auth-callout registration data-api-sampler trip-analyzer nats-bigtable-connector telemetry-chart-service data-web-client; do
```

- [ ] **Step 3: Non-interactive-safe, non-theater cleanup (F24)**

Replace the whole `phase_cleanup` body with:

```bash
phase_cleanup() {
    if [ -f ".env.infra" ] || [ -f ".env.base-services" ] || [ -f ".env.sample-services" ]; then
        warn "Previous setup detected"
        local reply=n
        if [ -t 0 ]; then
            read -p "Remove old configuration? (y/n) " -n 1 -r reply
            echo
        fi
        if [[ $reply =~ ^[Yy]$ ]]; then
            log "Removing old config files..."
            rm -f .env.infra .env.base-services .env.sample-services
            info "Old configuration removed"
        else
            info "Keeping existing .env files (templates will only fill missing ones)"
        fi
    fi
}
```

Replace the `phase_base_env` body with:

```bash
phase_base_env() {
    log "Creating base environment files..."
    local f
    for f in infra base-services sample-services; do
        if [ ! -f ".env.$f" ]; then
            cp "configs/$f.template" ".env.$f"
            info "Created .env.$f from template"
        else
            info "Keeping existing .env.$f"
        fi
    done
}
```

- [ ] **Step 4: Placeholder fail-fast (F23)**

At the end of `phase_inject_tokens`, after the `rm -f .env.*.bak` line, add:

```bash
    # Fail fast if any placeholder secret was not replaced by injection.
    if grep -lq "REPLACE_ME" .env.infra .env.base-services .env.sample-services; then
        error "Placeholder secret(s) still present after token injection - refusing to continue"
    fi
```

- [ ] **Step 5: Realm `sslRequired` none (F22)**

In `local-dev/keycloak/nexus-realm.json`, replace `"sslRequired": "external"` with `"sslRequired": "none"`.

- [ ] **Step 6: Compose.infra — remove dead NATS env block (F25) and lock MQTT down (F28)**

In `docker-compose.infra.yml`, delete the nats `environment:` block (NATS_AUTH_CALLOUT_PASSWORD / NATS_BASIC_AUTH_PASSWORD / NATS_CONNECTOR_PASSWORD / NATS_AUTH_CALLOUT_NKEY_PUB — dead: the image entrypoint applies NATS_* env only when no `-c` config file is given, and this service always passes one; real creds live in the generated `config/nats.conf`).

Replace the mosquitto ports:

```yaml
    ports:
      - "1883:1883"
      - "8883:8883"
```
with:
```yaml
    ports:
      - "127.0.0.1:1883:1883"
```

Add a data volume for persistence (mosquitto.conf has `persistence true` with `persistence_location /mosquitto/data/` but no volume — state silently lost on recreate):

```yaml
    volumes:
      - ./config/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro
      - mosquitto-data:/mosquitto/data
```

and add `mosquitto-data:` to the top-level `volumes:` block (next to `keycloak-data:`).

- [ ] **Step 7: Compose.certs — remove dead volume, use bash (F26)**

Delete the top-level `volumes:` block in `docker-compose.certs.yml`:

```yaml
volumes:
  certs:
    driver: local
    driver_opts:
      type: none
      device: ${PWD}/certs
      o: bind
```

Replace the cert-generator command:

```yaml
      sh -c "
        apk add --no-cache openssl &&
        /bin/sh /workspace/scripts/generate-certs.sh
      "
```
with:
```yaml
      sh -c "
        apk add --no-cache openssl bash &&
        bash /workspace/scripts/generate-certs.sh
      "
```

- [ ] **Step 8: Verify**

```bash
bash -n local-dev/setup-automated.sh
docker compose -f local-dev/docker-compose.infra.yml config --quiet
docker compose -f local-dev/docker-compose.certs.yml config --quiet
grep -n 'base64 -b' local-dev/setup-automated.sh || echo "no BSD-only base64"
```
Expected: all exit 0; "no BSD-only base64".

- [ ] **Step 9: Commit**

```bash
git add local-dev/setup-automated.sh local-dev/docker-compose.infra.yml local-dev/docker-compose.certs.yml local-dev/keycloak/nexus-realm.json
git commit -m "fix(local-dev): portable shell, honest crash detection, placeholder fail-fast, dead compose config removal"
```

---

### Task 13: G5b — scripts, Makefile, templates (F19, F21, F23, F27)

**Files:**
- Modify: `local-dev/scripts/wait-for-services.sh`
- Modify: `local-dev/Makefile`
- Modify: `local-dev/scripts/generate-certs.sh`
- Modify: `local-dev/configs/infra.template`
- Modify: `local-dev/configs/base-services.template`

**Interfaces:**
- Produces: `make clean` removes `local-dev/certs/` (making the documented "regenerates the full PKI" true); cert generation gates on the complete cert set and wipes partial state; scripts exit non-zero on failure; templates carry no live key material (fail-fast enforced by Task 12 Step 4).

- [ ] **Step 1: wait-for-services.sh honest exit (F19)**

Replace the file body (from the `wait_for()` function down) with:

```bash
failed=0

wait_for() {
    local name=$1
    shift
    local max_attempts=${1:-30}
    shift || true
    local delay=${1:-2}
    shift || true
    local i
    log "Waiting for $name..."
    for i in $(seq 1 "$max_attempts"); do
        if "$@" > /dev/null 2>&1; then
            log "$name is healthy"
            return 0
        fi
        sleep "$delay"
    done
    error "$name failed health check after $((max_attempts * delay)) seconds"
    return 1
}

wait_for "NATS" 30 2 curl -f http://localhost:8222/healthz || failed=1
wait_for "Keycloak" 30 2 curl -f http://localhost:8080/realms/nexus-sdv || failed=1
wait_for "Bigtable Emulator" 30 2 nc -z localhost 8086 || failed=1
wait_for "Mosquitto" 30 2 nc -z localhost 1883 || failed=1

if [ "$failed" -eq 0 ]; then
    log "All services are healthy!"
    exit 0
else
    error "One or more services failed health checks"
    exit 1
fi
```

- [ ] **Step 2: Makefile clean removes certs (F21)**

In `local-dev/Makefile`, replace the clean target:

```makefile
clean:
	docker compose -f docker-compose.infra.yml down -v 2>/dev/null || true
	docker compose down -v 2>/dev/null || true
	rm -f .env.infra .env.base-services .env.sample-services
	@echo "✓ All containers and volumes removed"
```
with:
```makefile
clean:
	docker compose -f docker-compose.infra.yml down -v 2>/dev/null || true
	docker compose down -v 2>/dev/null || true
	rm -f .env.infra .env.base-services .env.sample-services
	rm -rf certs
	@echo "✓ All containers, volumes, env files and generated PKI removed"
```

- [ ] **Step 3: generate-certs.sh complete-set gating + remove dead device cert (F21, F27)**

Replace the gate block:

```bash
# Check if already generated
if [[ -f "$CERTS_DIR/ca/ca.crt.pem" ]]; then
    log "Certificates already exist, skipping generation"
    exit 0
fi
```
with:

```bash
REQUIRED_CERTS=(
    "$CERTS_DIR/ca/ca.crt.pem" "$CERTS_DIR/ca/ca.key.pem"
    "$CERTS_DIR/nats/server.crt.pem" "$CERTS_DIR/nats/server.key.pem"
    "$CERTS_DIR/registration/server.crt.pem" "$CERTS_DIR/registration/server.key.pem"
    "$CERTS_DIR/registration/ca.crt.pem" "$CERTS_DIR/registration/ca.key.pem"
    "$CERTS_DIR/registration/factory-ca.crt.pem" "$CERTS_DIR/registration/factory-ca.key.pem"
    "$CERTS_DIR/keycloak/server.crt.pem" "$CERTS_DIR/keycloak/server.key.pem"
)

all_present=1
for f in "${REQUIRED_CERTS[@]}"; do
    [ -f "$f" ] || all_present=0
done

if [ "$all_present" -eq 1 ]; then
    log "All certificates already exist, skipping generation"
    exit 0
fi

# Partial PKI from an interrupted run breaks later phases opaquely - wipe and
# regenerate from scratch (a full set is ~10s in the cert-generator container).
if [ -d "$CERTS_DIR" ] && [ -n "$(ls -A "$CERTS_DIR" 2>/dev/null)" ]; then
    warn "Partial certificate tree detected - regenerating from scratch"
    rm -rf "$CERTS_DIR"
fi
```

Also: change `mkdir -p ... "$CERTS_DIR/clients"` to drop `clients`, and delete the entire "Generating Test Device Certificate" block (lines 141–147) — the cert is signed by the registration CA while registration validates against the factory CA, and nothing references `certs/clients/`.

- [ ] **Step 4: Template placeholders (F23)**

In `local-dev/configs/infra.template`, replace:

```
NATS_AUTH_CALLOUT_NKEY_PUB=ACMG6LYI6LEKM4HK2JGPLHH7WU2ZFQZSVLHLLTOBKO3ACPZ7GPBMFMAY
```
with:
```
NATS_AUTH_CALLOUT_NKEY_PUB=REPLACE_ME_NATS_AUTH_CALLOUT_NKEY_PUB
```
and:
```
NATS_ACCOUNT_SIGNING_KEY=SAABYYTIZUVT3W7GFSABQWL3O6R4QNADWPDFWYK2TCN6MLWVCGDT62VKCM
```
with:
```
NATS_ACCOUNT_SIGNING_KEY=REPLACE_ME_NATS_ACCOUNT_SIGNING_KEY
```

In `local-dev/configs/base-services.template`, replace:

```
JWT_ACC_SIGNING_KEY=SAABYYTIZUVT3W7GFSABQWL3O6R4QNADWPDFWYK2TCN6MLWVCGDT62VKCM
```
with:
```
JWT_ACC_SIGNING_KEY=REPLACE_ME_JWT_ACC_SIGNING_KEY
```
and the whole line starting `KEYCLOAK_JWK_B64=eyJrZXlzIjpb...` (the real JWKS snapshot) with:
```
KEYCLOAK_JWK_B64=REPLACE_ME_KEYCLOAK_JWK_B64
```
(Match by key prefix `KEYCLOAK_JWK_B64=` — the value is a single long line; replace the entire line.)

- [ ] **Step 5: Verify**

```bash
bash -n local-dev/scripts/wait-for-services.sh local-dev/scripts/generate-certs.sh
grep -rn 'SAABYYTIZUVT3W7GFSABQWL3O6R4QNADWPDFWYK2TCN6MLWVCGDT62VKCM\|ACMG6LYI6LEKM4HK2JGPLHH7WU2ZFQZSVLHLLTOBKO3ACPZ7GPBMFMAY' local-dev/ || echo "no live seeds in local-dev/"
grep -n 'rm -rf certs' local-dev/Makefile
```
Expected: syntax OK, "no live seeds in local-dev/", Makefile match.

- [ ] **Step 6: Commit**

```bash
git add local-dev/scripts/wait-for-services.sh local-dev/Makefile local-dev/scripts/generate-certs.sh local-dev/configs/infra.template local-dev/configs/base-services.template
git commit -m "fix(local-dev): honest wait exit codes, clean removes PKI, full cert-set gating, placeholder secrets"
```

---

### Task 14: G6 — Docs corrections (F30)

**Files:**
- Modify: `local-dev/README.md`
- Modify: `local-dev/ARCHITECTURE.md`
- Modify: `sample-clients/data-web-client/docs/theming.md`

**Interfaces:**
- Produces: docs match the post-fix behavior (vehicle flow works via client secret; NATS→Bigtable writer exists; `make clean` regenerates PKI; theming doc matches oklch globals.css).

- [ ] **Step 1: README — stale "no writer" + realm-mismatch rows**

In `local-dev/README.md` "Known gaps & gotchas" table, replace the row:

```
| **No NATS → Bigtable writer** | NATS telemetry never lands in Bigtable | Use `make ingest` to populate Bigtable; watch NATS separately |
```
with:
```
| **NATS → Bigtable writer** | `nats-bigtable-connector` persists both `telemetry.{VIN}` and `telemetry-generic.{VIN}.{sensor}` into Bigtable | Smoke-tested by `make test` (Tests 4–5) |
```

Replace the row:

```
| **Vehicle-client Keycloak realm mismatch** | See below | Larger piece of work; not yet resolved |
```
with:
```
| **Vehicle-client Keycloak realm mismatch** | See below | Resolved: per-VIN client `VIN123` (secret from realm via jq) — `make vehicle-client` works end to end |
```

In the Troubleshooting table, replace:

```
| `make query` returns nothing | Expected on a fresh env — nothing writes NATS→Bigtable. Run `make ingest` first. |
```
with:
```
| `make query` returns nothing | Fresh env has no rows — run `make ingest` (sample row) or `make vehicle-client` (live flow) |
```

- [ ] **Step 2: ARCHITECTURE.md — verify PKI claim (now true)**

No change needed to line 396 (`make clean && make go` now genuinely regenerates the PKI after Task 13). Add one sentence to the "Data persistence" section after line 406: "`make clean` also removes `local-dev/certs/`, so the next `make go` regenerates the full PKI."

- [ ] **Step 3: theming.md — oklch reality**

In `sample-clients/data-web-client/docs/theming.md`, replace the entire "### CSS Variables (globals.css)" section — from the heading through the closing ``` of the code block — with:

1. The section heading, kept as-is.
2. A code block containing the **verbatim contents of `src/app/globals.css`** (copy the file's exact text: the three `@import` lines, `@custom-variant dark`, the full `@theme inline` block, and the complete `:root` / `.dark` variable sets — all `oklch(...)` values).
3. The sentence: "Tokens are **oklch()** values; the `@theme inline` block maps them into Tailwind's `--color-*` namespace. HSL is not used. Add new tokens in `:root` / `.dark` in this file."

(Do not invent variable values — copy them from `src/app/globals.css` verbatim. Keep the rest of the doc — provider/toggle/usage sections are accurate.)

- [ ] **Step 4: Verify**

```bash
grep -n "nothing writes NATS→Bigtable\|No NATS → Bigtable writer\|not yet resolved" local-dev/README.md || echo "README updated"
grep -n "HSL is not used" sample-clients/data-web-client/docs/theming.md
```
Expected: "README updated", theming match.

- [ ] **Step 5: Commit**

```bash
git add local-dev/README.md local-dev/ARCHITECTURE.md sample-clients/data-web-client/docs/theming.md
git commit -m "docs: correct stale claims (NATS→Bigtable writer, vehicle flow, PKI regeneration, theming tokens)"
```

---

### Task 15: Final verification + runtime offer

**Files:** none (verification only).

- [ ] **Step 1: Web client**

Run: `cd sample-clients/data-web-client && bun install --frozen-lockfile && bun run test && bun run lint`
Expected: all tests pass, lint exit 0.

- [ ] **Step 2: Shell**

```bash
bash -n local-dev/setup-automated.sh local-dev/go.sh local-dev/scripts/*.sh
```
Expected: all exit 0.

- [ ] **Step 3: Java**

Run: `cd sample-services/telemetry-chart-service && ./mvnw -q test`
Expected: BUILD SUCCESS (TelemetryServiceRowKeyTest + any existing tests).

- [ ] **Step 4: Go modules untouched compile sanity**

Run: `cd base-services/auth-callout && go build ./... && cd ../nats-bigtable-connector && go build ./...`
Expected: both build (auth-callout unchanged by design; connector Dockerfile edit is build-time only).

- [ ] **Step 5: Repo state**

```bash
git status --short
git log --oneline origin/main..HEAD | head -20
```
Expected: clean tree; new commits listed on `feat/local-dev-no-gcp` only.

- [ ] **Step 6: Offer the runtime bring-up**

Report results and offer to run `make clean && make go && make test && make vehicle-client` (2–3 min docker bring-up) to verify the two `[runtime]` items: Keycloak service-account roles in the token (`realm_access.roles`) and emulator `reversed()` reads. Do NOT run it without user consent (long-running, network-heavy).
