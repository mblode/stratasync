"""stdin/stdout driver protocol, backed by the same Swift engine scenario adapter as CI."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
command = sys.argv[1] if len(sys.argv) == 2 else ""
if command == "version":
    print(json.dumps({"driver": "stratasync-swift", "protocolVersion": 1}))
elif command == "capabilities":
    print((root / "packages/conformance/corpus/capabilities/stratasync-swift.json").read_text())
elif command == "run":
    scenario = json.load(sys.stdin)
    with tempfile.TemporaryDirectory(prefix="stratasync-scenario-") as directory:
        input_file = Path(directory) / "scenario.json"
        output_file = Path(directory) / "result.json"
        input_file.write_text(json.dumps(scenario))
        environment = dict(os.environ, STRATASYNC_SCENARIO_INPUT=str(input_file), STRATASYNC_SCENARIO_OUTPUT=str(output_file))
        result = subprocess.run(["swift", "test", "--filter", "ConformanceScenarioTests/driverScenario"], cwd=root, env=environment, stdout=sys.stderr)
        if result.returncode != 0 or not output_file.exists():
            raise SystemExit(result.returncode or 1)
        # A false verdict is a successful protocol exchange, not an execution failure.
        print(output_file.read_text())
else:
    raise SystemExit("Usage: swift-conformance-driver.py capabilities|version|run")
