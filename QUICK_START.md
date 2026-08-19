# Nexus SDV - Quick Start (30 seconds)

## 🚀 Start Everything (One Command)

```bash
cd local-dev
make go
```

That's it! Everything happens automatically:
- ✅ Generates TLS certificates
- ✅ Creates NATS NKey pairs
- ✅ Generates Keycloak JWKS token
- ✅ Injects all secrets automatically
- ✅ Starts all services
- ✅ Verifies everything works

**No token copying. No manual configuration. No hardcoding.**

---

## 📊 What You Get

After `make go`, all these are ready:

| Service | URL | Status |
|---------|-----|--------|
| NATS | `nats://localhost:4222` | ✅ Ready |
| Keycloak | `http://localhost:8080` | ✅ Ready |
| Bigtable | `localhost:8086` | ✅ Ready |
| Mosquitto | `localhost:1883` | ✅ Ready |
| Data API | `grpc://localhost:9090` | ✅ Ready |
| Registration | `https://localhost:8444` | ✅ Ready |

---

## 📝 Common Tasks

```bash
# Watch logs in real-time
make logs

# View Bigtable telemetry data
make query

# Query specific vehicle/date
bash scripts/query-bigtable.sh "VIN123/2026-07-13"

# Run integration tests
make test

# Check service status
docker compose ps

# Execute command in service
docker compose exec data-api /bin/sh

# Stop everything
make stop

# Stop and remove everything
make clean
```

---

## 🔐 Credentials (Auto-Generated)

| Service | User | Password |
|---------|------|----------|
| Keycloak | admin | admin |
| NATS | app-user | app-pass |
| NATS (connector) | connector | connector-pass |

**All other tokens are auto-generated:**
- NATS NKey (random)
- Keycloak JWT (from server)
- Bigtable JWKS (extracted automatically)

---

## 🎯 Typical Workflow

```bash
# Day 1: Initial setup
cd local-dev
make go              # One-time setup (~2-3 minutes)

# Daily development
make logs            # Watch services
make query           # Check data
make test            # Verify changes

# When done
make stop            # Stop gracefully
```

---

## ❌ If Something Goes Wrong

```bash
# View detailed logs for a service
docker compose logs data-converter

# Check service status
docker compose ps

# Restart a service
docker compose restart data-api

# Complete reset (removes all data)
make clean
make go
```

---

## 📂 Files Reference

```
local-dev/
├── go.sh                    # ← One-command start
├── setup-automated.sh       # ← Full automated setup
├── Makefile                 # ← All commands
├── docker-compose.yml       # ← App services
├── docker-compose.infra.yml # ← Infrastructure
└── scripts/
    ├── query-bigtable.sh    # ← Query data
    └── test-local-flow.sh   # ← Run tests
```

---

## 💡 Pro Tips

1. **Keep logs running while developing:**
   ```bash
   # Terminal 1
   make logs
   
   # Terminal 2 (do your work here)
   make query
   ```

2. **Quickly inspect a service:**
   ```bash
   docker compose exec data-api /bin/sh
   ```

3. **Find the generated tokens:**
   ```bash
   # NATS NKey
   grep NATS_AUTH_CALLOUT_NKEY_PUB .env.infra
   
   # Keycloak JWT
   grep KEYCLOAK_JWK_B64 .env.base-services | head -c 100
   ```

4. **Test specific service:**
   ```bash
   docker compose logs -f data-converter
   ```

---

## 🐛 Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | `lsof -i :8080` to find what's using it |
| Services won't start | `make clean` then `make go` to reset |
| Can't query Bigtable | Wait 30s after startup, then `make query` |
| Certificate errors | `make clean` then `make go` to regenerate |

---

## ✨ What's Automatic Now

- ✅ Certificate generation
- ✅ NATS NKey creation
- ✅ Keycloak JWT extraction
- ✅ Token injection into configs
- ✅ Service startup
- ✅ Health verification
- ✅ Network creation

**Nothing is hardcoded. Nothing needs manual setup.**

---

**That's it! You're ready to develop.** 🚀
