.PHONY: help go setup-auto logs stop clean query test status shell

# ============================================================================
# FASTEST WAY TO START (One command!)
# ============================================================================
go:
	@bash go.sh

help:
	@echo "Nexus SDV Local Development - Commands"
	@echo ""
	@echo "  make go              - One-command setup + start (recommended)"
	@echo "  make setup-auto      - Run the automated setup without starting services"
	@echo ""
	@echo "Inspection:"
	@echo "  make logs            - Tail all logs in real-time"
	@echo "  make query           - Query Bigtable for telemetry"
	@echo "  make test            - Run end-to-end test"
	@echo "  make status          - Show service status"
	@echo "  make shell           - Open shell in data-api container"
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
