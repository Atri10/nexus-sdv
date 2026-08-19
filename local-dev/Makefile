.PHONY: help setup start infra services logs stop clean query test

help:
	@echo "Nexus SDV Local Development - Quick Commands"
	@echo ""
	@echo "Setup & Start:"
	@echo "  make setup    - One-time setup (certs, configs, networks)"
	@echo "  make start    - Start all services (infra + app)"
	@echo "  make infra    - Start only infrastructure"
	@echo "  make services - Start only application services"
	@echo ""
	@echo "Inspection:"
	@echo "  make logs     - Tail all logs (Ctrl+C to stop)"
	@echo "  make query    - Query Bigtable for telemetry data"
	@echo "  make test     - Run end-to-end test flow"
	@echo ""
	@echo "Cleanup:"
	@echo "  make stop     - Stop all containers (keeps volumes)"
	@echo "  make clean    - Stop containers and remove volumes"
	@echo ""

setup:
	@bash scripts/setup-local-dev.sh
	@docker network create nexus-local 2>/dev/null || echo "Network already exists"

start: infra services
	@echo "✓ All services started!"

infra:
	@bash scripts/start-infra.sh

services:
	@bash scripts/start-services.sh

logs:
	docker compose logs -f

stop:
	docker compose -f docker-compose.infra.yml down
	docker compose down

clean:
	docker compose -f docker-compose.infra.yml down -v
	docker compose down -v
	@echo "✓ All containers stopped and volumes removed"

query:
	@bash scripts/query-bigtable.sh

test:
	@bash scripts/test-local-flow.sh

status:
	@docker compose ps
	@echo ""
	@docker compose -f docker-compose.infra.yml ps
