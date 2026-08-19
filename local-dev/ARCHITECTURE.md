# Nexus SDV Local Development Architecture

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
│  │  Broker      │  │  Auth/OAuth  │  │  Database    │  │  MQTT        │   │
│  │ :4222       │  │ :8080, :8443 │  │  :8086       │  │  :1883       │   │
│  │  (NKey Auth) │  │  (JWT)       │  │  (Emulator)  │  │  (MQTT v5)   │   │
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
│           │                       │  │ (MQTT → NATS → Bigtable)       │ │  │
│           │ MQTT                  │  │ ┌─────────────┬─────────────┐   │ │  │
│           ▼                       │  │ │   NATS      │  Bigtable   │   │ │  │
│     ┌──────────────┐              │  │ │  Publish    │  Write      │   │ │  │
│     │ Mosquitto    │◄─────────────┼──┼─►  telemetry │            │   │ │  │
│     │   MQTT       │              │  │ └─────────────┴─────────────┘   │ │  │
│     │  :1883       │              │  └─────────────────────────────────┘ │  │
│     └──────────────┘              │                                      │  │
│                                   │  ┌──────────────────────────────────┐ │  │
│                                   │  │ Auth Callout                     │ │  │
│                                   │  │ (NATS ← Keycloak JWT)           │ │  │
│                                   │  │ Validates: JWT → NATS NKey      │ │  │
│                                   │  └──────────────────────────────────┘ │  │
│                                   │                                      │  │
│     ┌──────────────┐              │  ┌──────────────────────────────────┐ │  │
│     │ Data API     │◄─────────────┼──┼─ Data API (gRPC)                │ │  │
│     │ Consumer     │              │  │ ┌──────────────────────────────┐ │ │  │
│     │ :9090        │              │  │ │ Telemetry Queries from BT    │ │ │  │
│     └──────────────┘              │  │ └──────────────────────────────┘ │ │  │
│                                   │  └──────────────────────────────────┘ │  │
│     ┌──────────────┐              │                                      │  │
│     │ Vehicle      │              │  ┌──────────────────────────────────┐ │  │
│     │ Registration │◄─────────────┼──┼─ Registration (HTTPS/TLS)       │ │  │
│     │ :8444        │              │  │ ┌──────────────────────────────┐ │ │  │
│     └──────────────┘              │  │ │ Cert Management, Validation  │ │ │  │
│                                   │  │ └──────────────────────────────┘ │ │  │
│                                   │  └──────────────────────────────────┘ │  │
│                                   │                                      │  │
│  ┌──────────────────────────────┐ │  ┌──────────────────────────────────┐ │  │
│  │ SAMPLE SERVICES              │ │  │ Data API Sampler                 │ │  │
│  │                              │ │  │ (Generates sample telemetry)     │ │  │
│  │ • Data API Sampler           │ │  └──────────────────────────────────┘ │  │
│  │ • Trip Analyzer              │ │                                      │  │
│  └──────────────────────────────┘ │                                      │  │
│                                   │                                      │  │
└───────────────────────────────────┴──────────────────────────────────────┘
```

---

## Data Flow Diagram

### Telemetry Ingestion Path
```
Vehicle/Sensor
      │
      │ (MQTT publish)
      ▼
   Mosquitto (MQTT Broker)
      │
      │ (subscribe: telemetry/#)
      ▼
   Data Converter Service
      │
      ├─► Extract telemetry data
      ├─► Parse message format
      ├─► Validate schema
      │
      ▼
   NATS (Message Broker)
      │
      ├─► Authenticate (NKey)
      ├─► Publish to "telemetry.data" subject
      │
      ▼
   Bigtable Emulator
      │
      ├─► Store in "telemetry" table
      ├─► Row key: VIN/timestamp
      └─► Columns: sensor data, metadata
```

### Query Path
```
Client/Consumer
      │
      │ (gRPC request: GetTelemetry)
      ▼
   Data API Service (:9090)
      │
      ├─► Authenticate request
      ├─► Validate parameters
      │
      ▼
   Bigtable Emulator
      │
      ├─► Query "telemetry" table
      ├─► Row range: VIN/date range
      ├─► Return serialized data
      │
      ▼
   gRPC Response
      │
      └─► Telemetry records
```

### Authentication Flow
```
Vehicle Certificate
      │
      │ (mTLS: client cert + key)
      ▼
Registration Service (:8444)
      │
      ├─► Validate cert chain
      ├─► Check CA signature
      ├─► Verify factory CA
      │
      ▼
Issue JWT Token
      │
      │ (OAuth2 code flow)
      ▼
   Keycloak (:8080)
      │
      ├─► Create session
      ├─► Generate JWT
      ├─► Sign with RS256 key
      │
      ▼
JWT Token (Bearer Token)
      │
      │ (Used for NATS connection)
      ▼
   Auth Callout Service
      │
      ├─► Receive JWT
      ├─► Call Keycloak JWKS endpoint
      ├─► Verify JWT signature
      ├─► Extract claims
      │
      ▼
NATS NKey Connection Authorized
      │
      └─► Subscribe to subjects
```

---

## Component Details

### 1. **NATS (localhost:4222)**
```
┌─ NATS Server ──────────────────────────────────────┐
│                                                    │
│ Subjects:                                         │
│  • telemetry.data          - Published data      │
│  • telemetry.queries       - Query requests      │
│  • auth.verify            - JWT verification    │
│                                                    │
│ Authentication:                                    │
│  • NKey (Public/Private Key Pair)               │
│  • Auth Callout: JWT ↔ NKey mapping             │
│                                                    │
│ Storage: In-memory (no persistence)              │
└────────────────────────────────────────────────────┘
```

### 2. **Keycloak (localhost:8080, :8443)**
```
┌─ Keycloak Identity Provider ───────────────────────┐
│                                                    │
│ Realm: nexus-sdv                                  │
│ Admin: admin/admin                                │
│                                                    │
│ Clients:                                          │
│  • vehicle-client                                │
│  • other-client                                  │
│                                                    │
│ Protocols:                                        │
│  • OpenID Connect (OAuth2)                       │
│  • SAML 2.0 (if enabled)                        │
│                                                    │
│ Token:                                            │
│  • JWT signed with RS256                        │
│  • JWKS endpoint: /realms/nexus-sdv/certs      │
│                                                    │
│ Features:                                         │
│  • User management                              │
│  • Role-based access control                    │
│  • Multi-realm support                          │
└────────────────────────────────────────────────────┘
```

### 3. **Bigtable Emulator (localhost:8086)**
```
┌─ Google Cloud Bigtable Emulator ──────────────────┐
│                                                   │
│ Project: test-project                            │
│ Instance: test-instance                          │
│                                                   │
│ Table: telemetry                                 │
│  ├─ Row Format: VIN/YYYY-MM-DD/HH:MM:SS       │
│  ├─ Column Families:                            │
│  │  ├─ sensor_data                             │
│  │  ├─ metadata                                │
│  │  └─ computed                                │
│  │                                              │
│  └─ Example Rows:                              │
│     ├─ VIN123/2026-07-13/14:30:00             │
│     ├─ VIN123/2026-07-13/14:31:00             │
│     └─ VIN456/2026-07-13/14:32:00             │
│                                                   │
│ Storage: Local filesystem (~/Library/emul...)   │
│ Persistence: Yes (between container restarts)  │
└────────────────────────────────────────────────────┘
```

### 4. **Mosquitto MQTT Broker (localhost:1883)**
```
┌─ Eclipse Mosquitto MQTT Broker ───────────────────┐
│                                                   │
│ Protocol: MQTT v5.0 (backward compatible)       │
│ Port: 1883 (unencrypted, for local dev)        │
│ Port: 8883 (TLS encrypted, optional)           │
│                                                   │
│ Topics:                                          │
│  • telemetry/#              - Device data      │
│  • telemetry/VIN/sensors/*  - Sensor values   │
│  • command/#                - Device commands │
│  • status/#                 - Status reports  │
│                                                   │
│ Features:                                        │
│  • Subscription wildcards                      │
│  • Retained messages                           │
│  • Quality of Service (QoS 0, 1, 2)           │
│                                                   │
│ Configuration: /mosquitto/config/mosquitto.conf │
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
   Services          (Production-like)       (Testing/Demo)

   • NATS             • Data API           • Data API Sampler
   • Keycloak         • Auth Callout       • Trip Analyzer
   • Bigtable         • Data Converter
   • Mosquitto        • Registration
   
   ↓ (Shared)
   
   Volumes:          Certificates:         Config:
   • Bigtable store  • CA root cert       • nats.conf
   • Keycloak DB     • Server certs       • mosquitto.conf
                     • Client certs       • data-converter.yaml
                     • Keycloak JWKS
```

---

## Communication Patterns

### Pattern 1: Request-Response (Synchronous)
```
Client ──► gRPC Request ──► Data API
                              │
                              │ Query
                              ▼
                          Bigtable
                              │
                              │ Result
                              ▼
         ◄── gRPC Response ◄──
```

### Pattern 2: Publish-Subscribe (Asynchronous)
```
Device ──► MQTT Publish ──► Mosquitto
                              │
                              │ Forward
                              ▼
                          Data Converter
                              │
                              │ Transform
                              ▼
                            NATS
                              │
                              │ Subscribe
                              ▼
                          Multiple Listeners
                          (Bigtable, Analytics, etc.)
```

### Pattern 3: Authentication
```
Vehicle ──► Certificate ──► Registration
                              │
                              │ Validate & Issue
                              ▼
                          Keycloak (JWT)
                              │
                              │ Token
                              ▼
        ◄──────────────────────
             │
             │ Use JWT
             ▼
         NATS → Auth Callout
         (Verify JWT)
             │
             ▼
         NKey Connection
```

---

## Scaling Considerations

### Development
- All services in one docker-compose
- Shared network
- Direct port mapping

### Production
```
Load Balancer
      ▼
   API Gateway
      ▼
   Service Mesh (Istio)
      ▼
   ┌──────────────┬──────────────┬──────────────┐
   ▼              ▼              ▼
Data API      Auth-Callout   Data Converter
(replicas)    (replicas)     (replicas)
   │              │              │
   └──────────────┴──────────────┘
              ▼
        Managed Services
        (Cloud SQL, Pub/Sub, etc.)
```

---

## Monitoring & Observability

### Built-in Endpoints

```
Service              Health Check         Metrics
────────────────────────────────────────────────
NATS                 :8222/healthz        :8222/varz
Keycloak             :8080/health/ready   N/A
Bigtable Emulator    PORT:8086 (TCP)      N/A
Mosquitto            PORT:1883 (TCP)      N/A
Data API             gRPC health check    N/A
Registration         PORT:8888 (HTTP)     N/A
```

### Log Aggregation

```bash
# All service logs
docker compose logs -f

# Specific service
docker compose logs data-converter

# Last 100 lines
docker compose logs --tail=100

# With timestamps
docker compose logs --timestamps
```

---

## Network Topology

```
      ┌─────────────────────────────┐
      │   Docker Network            │
      │   nexus-local (bridge)      │
      │                             │
      │  IP Range: 172.18.0.0/16    │
      │                             │
      │  ┌──────────────────────┐   │
      │  │ Service Container    │   │
      │  │ IP: 172.18.0.x       │   │
      │  │ Hostname: service    │   │
      │  └──────────────────────┘   │
      │                             │
      └──────────────┬──────────────┘
                     │
              Docker Bridge Interface
                     │
              Host Network (localhost)
```

---

## File Storage Layout

```
local-dev/
├── certs/
│   ├── ca/                          # Root CA
│   ├── registration/                # Server certs
│   ├── nats/                        # NATS server certs
│   ├── keycloak/                    # Keycloak certs + JWKS
│   └── clients/                     # Client certificates
│
├── config/
│   ├── nats.conf                    # NATS configuration
│   ├── mosquitto.conf               # Mosquitto config
│   └── data-converter.yaml          # Converter pipeline
│
├── keycloak/
│   └── nexus-realm.json             # Realm bootstrap
│
└── Docker data
    └── Bigtable storage             # Persisted in container
```

---

## Troubleshooting Architecture Issues

### Network Connectivity
```
Issue: Services can't reach each other
Solution:
  1. Verify network exists: docker network ls | grep nexus-local
  2. Inspect network: docker network inspect nexus-local
  3. Check if containers are on network: docker network inspect nexus-local
  4. Recreate network if needed: docker network create nexus-local
```

### Certificate Issues
```
Issue: TLS handshake failures
Solution:
  1. Regenerate certs: docker compose -f docker-compose.certs.yml up
  2. Or complete refresh: make clean && make setup
  3. Verify cert paths in docker-compose files
```

### Data Persistence
```
Issue: Data lost after restart
Solution:
  1. Bigtable: Data persists automatically (stored on host)
  2. Keycloak: Data persists in dedicated volume
  3. To clear all data: docker compose down -v (with -v flag)
```

---

**Last Updated**: July 13, 2026
**Architecture Version**: 1.0
