.PHONY: help go setup setup-auto start infra services logs stop clean query test status shell

# ============================================================================
# FASTEST WAY TO START (One command!)
# ============================================================================
go:
	@bash go.sh

# ============================================================================
# Traditional setup methods
# ============================================================================
help:
	@echo "Nexus SDV Local Development - Commands"
	@echo ""
	@echo "FASTEST START (Fully Automatic):"
	@echo "  make go              - One command setup + start (RECOMMENDED)"
	@echo ""
	@echo "Manual Control:"
	@echo "  make setup-auto      - Fully automated setup (no token copying)"
	@echo "  make setup           - Traditional setup (manual steps)"
	@echo "  make start           - Start all services"
	@echo "  make stop            - Stop all services"
	@echo ""
	@echo "Inspection:"
	@echo "  make logs            - Tail all logs in real-time"
	@echo "  make query           - Query Bigtable for telemetry"
	@echo "  make test            - Run end-to-end test"
	@echo "  make status          - Show service status"
	@echo "  make shell           - Open shell in data-api container"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean           - Stop and remove all volumes"
	@echo ""

setup-auto:
	@bash setup-automated.sh

setup:
	@bash scripts/setup-local-dev.sh
	@docker network create nexus-local 2>/dev/null || true

start: infra services
	@echo "✓ All services started!"

infra:
	@bash scripts/start-infra.sh

services:
	@bash scripts/start-services.sh

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
	@echo "✓ All containers and volumes removed"

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
