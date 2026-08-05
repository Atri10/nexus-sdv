.PHONY: help go demo setup-auto logs stop clean query ingest test status shell vehicle-client connector-logs frontend

# ============================================================================
# FASTEST WAY TO START (One command!)
# ============================================================================
go:
	@bash go.sh

demo:
	@bash go.sh
	docker compose up -d vehicle-simulator
	@echo "Opening demo dashboard..."
	@open http://localhost:3000/demo 2>/dev/null || true

help:
	@echo "Nexus SDV Local Development - Commands"
	@echo ""
	@echo "  make go              - One-command setup + start (recommended)"
	@echo "  make setup-auto      - Run the automated setup without starting services"
	@echo ""
	@echo "Demo:"
	@echo "  make demo            - Stack + simulator + open the /demo dashboard"
	@echo ""
	@echo "Inspection:"
	@echo "  make logs            - Tail all logs in real-time"
	@echo "  make connector-logs  - Tail nats-bigtable-connector logs"
	@echo "  make ingest          - Write a sample telemetry row into Bigtable"
	@echo "  make query           - Query Bigtable for telemetry"
	@echo "  make test            - Run end-to-end test"
	@echo "  make status          - Show service status"
	@echo "  make shell           - Open shell in data-api container"
	@echo "  make vehicle-client  - Register+publish telemetry with sample-clients/vehicle-client"
	@echo "  make frontend        - View frontend logs"
	@echo ""
	@echo "Cleanup:"
	@echo "  make stop            - Stop all containers (keeps volumes)"
	@echo "  make clean           - Stop containers, remove volumes and env files"
	@echo ""

setup-auto:
	@bash setup-automated.sh

logs:
	docker compose logs -f

stop:
	docker compose -f docker-compose.infra.yml down 2>/dev/null || true
	docker compose down 2>/dev/null || true
	@echo "✓ Services stopped"

clean:
	docker compose -f docker-compose.infra.yml down -v 2>/dev/null || true
	docker compose down -v 2>/dev/null || true
	rm -f .env.infra .env.base-services .env.sample-services
	rm -rf certs
	@echo "✓ All containers, volumes, env files and generated PKI removed"

ingest:
	@bash scripts/ingest-sample.sh

query:
	@bash scripts/query-bigtable.sh

test:
	@bash scripts/test-local-flow.sh

status:
	@docker compose ps
	@echo ""
	@docker compose -f docker-compose.infra.yml ps

shell:
	docker compose exec data-api /bin/sh

vehicle-client:
	@bash scripts/run-vehicle-client.sh

connector-logs:
	docker compose logs -f nats-bigtable-connector

frontend:
	docker compose logs -f data-web-client
