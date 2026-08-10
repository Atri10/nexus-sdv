import sys
from pathlib import Path

# Make the top-level scripts/ dir importable so tests can unit-test the
# evaluator/calibration one-off tools without a live data-api.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
