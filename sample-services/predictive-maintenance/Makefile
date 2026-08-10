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

# 3. Generate betterproto stubs from proto definitions.
# NOTE: betterproto >=2.0.0b6 emits package-per-proto-package output
# (model/pm/__init__.py) instead of the committed flat layout
# (model/pm_message.py). The committed stub is the contract every
# consumer imports; regenerate into a scratch dir and relocate, so `make
# proto` always reproduces the committed file.
proto:
	@echo "Generating betterproto stubs..."
	mkdir -p .proto-gen
	uv run python -m grpc_tools.protoc \
		-I proto \
		--python_betterproto_out=.proto-gen \
		proto/pm-message.proto
	mv .proto-gen/pm/__init__.py src/predictive_maintenance/model/pm_message.py
	uv run python -m grpc_tools.protoc \
		-I proto \
		--python_betterproto_out=src/predictive_maintenance/client/generated/ \
		proto/data-api.proto
	@echo "Done (relocated flat stub + data-api client)."

# 4. Cleanup
clean:
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -type d -name ".pytest_cache" -exec rm -rf {} +
