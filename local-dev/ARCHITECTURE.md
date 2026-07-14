# Nexus SDV Local Development Architecture

> Companion to [README.md](./README.md). The README is the task-oriented guide
> (how to start, ingest, query, watch NATS). This doc explains **how the system
> is wired** and the design decisions behind it.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         NEXUS SDV LOCAL ENVIRONMENT                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                          INFRASTRUCTURE LAYER                                │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │   NATS       │  │  Keycloak    │  │  Bigtable    │  │  Mosquitto   │   │
│  │  Broker      │  │  Auth/OAuth  │  │  Emulator    │  │  MQTT        │   │
│  │ :4222       │  │ :8080, :8443 │  │  :8086       │  │  :1883       │   │
│  │  (NKey +     │  │  (JWT,       │  │  (in-memory) │  │  (MQTT v5)   │   │
│  │  callout)    │  │  persisted)  │  │              │  │              │   │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                         Docker Network: nexus-local

┌──────────────────────────────────────────────────────────────────────────────┐
│                         APPLICATION LAYER                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐              ┌──────────────────────────────────────┐  │
│  │ Telemetry       │              │      CORE SERVICES                   │  │
│  │ Sources         │              │                                      │  │
│  │ (Vehicles)      │              │  ┌─────────────────────────────────┐ │  │
│  └────────┬────────┘              │  │ Data Converter                  │ │  │
│           │                       │  │ (MQTT → NATS only)             │ │  │
│           │ MQTT                  │  │                                 │ │  │
│           ▼                       │  │  subscribes MQTT telemetry/#    │ │  │
│     ┌──────────────┐              │  │  publishes NATS telemetry.>     │ │  │
│     │ Mosquitto    │◄─────────────┼──┤                                 │ │  │
│     │   MQTT       │              │  └─────────────────────────────────┘ │  │
│     │  :1883       │              │        │ (no NATS→Bigtable writer)   │  │
│     └──────────────┘              │        ▼  local dev drops here       │  │
│                                   │      (nothing consumes into BT)      │  │
│                                   │                                      │  │
│                                   │  ┌──────────────────────────────────┐ │  │
│                                   │  │ Auth Callout                     │ │  │
│                                   │  │ (validates Keycloak JWT → NATS   │ │  │
│                                   │  │  permissions, via JWKS snapshot) │ │  │
│                                   │  └──────────────────────────────────┘ │  │
│                                   │                                      │  │
│     ┌──────────────┐              │  ┌──────────────────────────────────┐ │  │
│     │ Data API     │◄─────────────┼──┤ Data API (gRPC)                  │ │  │
│     │ Consumer     │              │  │  reads Bigtable telemetry rows   │ │  │
│     │ :9090        │              │  └──────────────────────────────────┘ │  │
│     └──────────────┘              │                                      │  │
│                                   │  ┌──────────────────────────────────┐ │  │
│     ┌──────────────┐              │  │ Registration (HTTPS/mTLS)        │ │  │
│     │ Vehicle      │◄─────────────┼──┤  cert validation + issuance      │ │  │
│     │ Registration │              │  └──────────────────────────────────┘ │  │
│     │ :8444        │              │                                      │  │
│     └──────────────┘              │  ┌──────────────────────────────────┐ │  │
│                                   │  │ SAMPLE SERVICES                  │ │  │
│  ┌──────────────────────────────┐ │  │  • Data API Sampler              │ │  │
│  │ make ingest ─► Bigtable      │ │  │  • Trip Analyzer                 │ │  │
│  │ (the ONLY BT write path)     │ │  └──────────────────────────────────┘ │  │
│  └──────────────────────────────┘ │                                      │  │
└───────────────────────────────────┴──────────────────────────────────────┘
```

---

## Data Flow

### Telemetry ingestion path (and where it stops)

```
Vehicle / Sensor
      │  MQTT publish  (telemetry/<VIN>/sensors/*)
      ▼
   Mosquitto (MQTT broker, :1883)
      │  data-converter subscribes telemetry/#
      ▼
   Data Converter  ──►  parse / transform
      │  NATS publish (telemetry.>)
      ▼
   NATS (message broker, :4222)
      │
      ✗  NO consumer writes this into Bigtable in local dev.
         data-converter forwards to NATS and stops there.
         (See README §"The one thing to know first".)

   ── separately ──
   make ingest  ──►  Bigtable emulator (:8086)   ← the only write path locally
```

> ⚠ **This is the single most important thing to understand about local dev.**
> The NATS stream and the Bigtable table are **not connected** — there is no
> NATS → Bigtable writer. To get rows into Bigtable, use `make ingest`. To see
> what flows through NATS, subscribe to it directly (README §"Inspect live NATS
> messages"). In the GCP deployment a separate managed connector fills this gap;
> that component is out of scope for local dev.

### Query path

```
Client / Consumer
      │  gRPC GetTelemetry
      ▼
   Data API (:9090)
      │  scans Bigtable key range  <VIN>#<start> .. <VIN>#<end>
      ▼
   Bigtable emulator (:8086)
      │  returns matching rows
      ▼
   gRPC response
```

### Authentication flow (vehicle client)

```
Factory certificate
      │  mTLS (client cert + key)
      ▼
Registration service (:8444)
      │  validate factory CA chain → sign CSR
      ▼
Operational certificate  (+ Keycloak URL, NATS URL echoed back)
      │  mTLS
      ▼
Keycloak (:8080)
      │  validate → issue JWT (RS256), signed with the realm key
      ▼
JWT (bearer token)
      │  used as the NATS connect token
      ▼
NATS  ──►  Auth Callout
      │  looks up the JWT's `kid` in its JWKS snapshot,
      │  verifies the signature, maps roles → NATS permissions
      ▼
NATS connection authorized  ──►  publish telemetry.<VIN>.*
```

> The JWKS Auth Callout trusts is a **one-time snapshot** taken at setup, not a
> live fetch. If Keycloak's realm signing key changes, the snapshot goes stale
> and every fresh JWT is rejected with `Authorization Violation`. Keycloak now
> uses a persistent volume (see below) to keep its keys stable across restarts.

---

## Component Details

### 1. NATS (localhost:4222)

```
┌─ NATS Server ──────────────────────────────────────┐
│                                                    │
│ Accounts (config/nats.conf, generated at setup):   │
│  • AUTH  - auth-callout-service                    │
│  • APP   - app-user                                │
│  • SYS   - system account                          │
│                                                    │
│ Example subjects in use:                           │
│  • telemetry.<VIN>.battery   - default telemetry   │
│  • vehicle_reports.<VIN>     - metrics_report      │
│  • telemetry.>               - catch-all           │
│                                                    │
│ Authentication:                                    │
│  • Auth callout: Keycloak JWT → NATS permissions   │
│  • Bypass users (no callout): connector, app-user, │
│    auth-callout-service                            │
│  • Anonymous access is DENIED                      │
│                                                    │
│ Storage: in-memory (no persistence)                │
└────────────────────────────────────────────────────┘
```

### 2. Keycloak (localhost:8080, :8443)

```
┌─ Keycloak Identity Provider ───────────────────────┐
│                                                    │
│ Mode:  start-dev --import-realm                    │
│ Realm: nexus-sdv                                   │
│ Admin: admin / admin                               │
│                                                    │
│ Client: vehicle-client (confidential, client       │
│         secret; read from the realm import by the  │
│         local-dev run-vehicle-client.sh wrapper)   │
│                                                    │
│ Token: JWT signed RS256                            │
│ JWKS:  /realms/nexus-sdv/protocol/openid-connect/  │
│        certs                                       │
│                                                    │
│ Persistence: named volume keycloak-data mounted    │
│   at /opt/keycloak/data so the realm signing keys  │
│   survive container restarts (otherwise start-dev  │
│   regenerates them → stale auth-callout snapshot).  │
└────────────────────────────────────────────────────┘
```

### 3. Bigtable Emulator (localhost:8086)

```
┌─ Google Cloud Bigtable Emulator ──────────────────┐
│                                                   │
│ Project:  test-project                            │
│ Instance: test-instance                           │
│ Table:    telemetry                               │
│                                                   │
│ Row key:  <VIN>#<timestamp>                       │
│   timestamp fmt: 2006-01-02T15:04:05.000000000Z07:00
│   e.g. VIN123#2026-07-13T17:00:00.000000000Z      │
│                                                   │
│ Column families:                                  │
│   • dynamic   (e.g. dynamic:speed)                │
│   • static    (e.g. static:make)                  │
│   values stored as raw bytes                      │
│                                                   │
│ Source of truth for the layout:                   │
│   base-services/data-api/src/service/bigtable.go  │
│   base-services/data-api/src/service/time.go      │
│                                                   │
│ Storage: IN-MEMORY. A container restart wipes the │
│   table. make ingest/make query recreate the      │
│   table + families automatically.                 │
└────────────────────────────────────────────────────┘
```

### 4. Mosquitto MQTT Broker (localhost:1883)

```
┌─ Eclipse Mosquitto MQTT Broker ───────────────────┐
│                                                   │
│ Protocol: MQTT v5.0 (backward compatible)         │
│ Port: 1883 (plain, local dev) / 8883 (TLS)        │
│                                                   │
│ Topics:                                           │
│  • telemetry/#              - device data         │
│  • telemetry/<VIN>/sensors/* - sensor values      │
│                                                   │
│ data-converter subscribes telemetry/# and         │
│ forwards to NATS. No retained-message dependence. │
│                                                   │
│ Config: /mosquitto/config/mosquitto.conf          │
└────────────────────────────────────────────────────┘
```

---

## Service Deployment Model

```
                    Single Docker Network
                      (nexus-local)
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   Infrastructure        Base Services      Sample Services
   (infra compose)     (app compose)        (app compose)

   • NATS             • Data API           • Data API Sampler
   • Keycloak         • Auth Callout       • Trip Analyzer
   • Bigtable         • Data Converter
   • Mosquitto        • Registration

   Volumes:            Certificates:        Config:
   • keycloak-data     • CA root cert       • nats.conf (generated)
     (signing keys)    • server certs       • mosquitto.conf
   (Bigtable is        • client certs       • data-converter.yaml
    in-memory)         • Keycloak JWKS snap
```

---

## Communication Patterns

### Request-Response (synchronous)
```
Client ──► gRPC ──► Data API ──► Bigtable ──► rows ──► gRPC response
```

### Publish-Subscribe (asynchronous)
```
Device ──► MQTT ──► Mosquitto ──► Data Converter ──► NATS
                                                      │
                                                      ▼
                                            subscribers (e.g. nats-box
                                            with the connector user)
```

### Authentication
```
Vehicle ─cert─► Registration ─issues─► operational cert
        ─mTLS─► Keycloak ─issues─► JWT
        ─JWT──► NATS ─► Auth Callout ─verify JWKS─► NATS permissions
```

---

## Scaling Considerations

### Development (this environment)
- All services in Docker Compose on one bridge network
- Direct host port mapping
- No NATS → Bigtable connector (write via `make ingest`)

### Production (for reference)
```
Load Balancer ─► API Gateway ─► Service Mesh
                                   │
        ┌──────────────┬──────────┴───┬──────────────┐
        ▼              ▼               ▼              ▼
   Data API      Auth-Callout    Data Converter   NATS→Bigtable
   (replicas)    (replicas)      (replicas)       connector
        │              │               │              │
        └──────────────┴───────────────┴──────────────┘
                          ▼
                  Managed services (Cloud Bigtable, Pub/Sub, …)
```

The production **NATS → Bigtable connector** is the component intentionally
absent locally; it is what closes the ingestion loop in a real deployment.

---

## Monitoring & Observability

| Service | Health check | Metrics |
|---------|--------------|---------|
| NATS | `:8222/healthz` | `:8222/varz`, `/connz`, `/subsz` |
| Keycloak | `:8080/health/ready` | — |
| Bigtable emulator | TCP `:8086` | — |
| Mosquitto | TCP `:1883` | — |
| Data API | gRPC on `:9090` | — |
| Registration | `:8444` (HTTPS) | — |

```bash
docker compose logs -f              # all services
docker compose logs data-converter  # one service
docker compose logs --tail=100       # last 100 lines
```

---

## Network Topology

```
      ┌─────────────────────────────┐
      │   Docker Network            │
      │   nexus-local (bridge)      │
      │                             │
      │  ┌──────────────────────┐   │
      │  │ Service Container    │   │
      │  │ hostname = service   │   │  ← in-network: use 'nats', 'keycloak',
      │  │                      │   │    'bigtable-emulator' as hostnames
      │  └──────────────────────┘   │
      └──────────────┬──────────────┘
                     │  port mapping
              Host (localhost)          ← from the host: use localhost:<port>
```

> This is why `nats-box` (running **inside** the network) connects to
> `nats://nats:4222`, while host tools use `nats://localhost:4222`.

---

## Troubleshooting Architecture Issues

### Network connectivity
```
Symptom: services can't reach each other / "network nexus-local not found"
Fix:
  1. It's created by docker-compose.infra.yml — run 'make go'.
  2. Do NOT 'docker network create' it by hand: a manual network lacks the
     com.docker.compose.* labels the app compose file's 'external: true'
     expects, and 'docker compose up' then fails with an incorrect-label error.
  3. Inspect: docker network inspect nexus-local
```

### Certificate issues
```
Symptom: TLS handshake failures
Fix: make clean && make go   (regenerates the full PKI)
```

### Data persistence
```
Bigtable: IN-MEMORY — data is lost on container restart. Re-run 'make ingest'
          (it recreates the table + column families).
Keycloak: persisted in the keycloak-data volume so signing keys survive
          restarts. 'make clean' (down -v) removes it and forces a fresh realm
          import + new keys, which the same 'make go' re-snapshots for
          auth-callout.
```

### Auth / NATS Authorization Violation
```
Tooling (nats sub/pub): you connected with no credentials. Anonymous is denied.
  Use --user connector --password connector-pass.

Vehicle client: Keycloak rotated its realm signing key and auth-callout's JWKS
  snapshot is stale. Fixed by the keycloak-data volume; run 'make clean && make
  go' once to activate, or re-snapshot with 'make setup-auto' and recreate the
  auth-callout container. See README §"Known gaps & gotchas".
```

---

**Last Updated**: July 14, 2026
**Architecture Version**: 1.1
