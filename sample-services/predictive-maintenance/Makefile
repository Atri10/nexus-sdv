.PHONY: help install dev test proto clean

# Default target when you just type 'make'
help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo "  install     Install dependencies using uv"
	@echo "  test        Run all tests"
	@echo "  proto       Regenerate betterproto stubs from proto/"
	@echo "  clean       Remove temporary files and cache"

# 1. Setup & Install
install:
	uv sync

# 2. Testing
test:
	uv run pytest tests/

# 3. Generate betterproto stubs from proto definitions
proto:
	@echo "Generating betterproto stubs..."
	uv run python -m grpc_tools.protoc \
		-I proto \
		--python_betterproto_out=src/predictive_maintenance/model \
		proto/*.proto
	@echo "Done."

# 4. Cleanup
clean:
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -exec rm -rf {} +