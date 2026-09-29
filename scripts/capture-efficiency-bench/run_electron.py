"""Measure a real Electron upload with an unchanged, specified runtime."""
import argparse, subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--electron", type=Path, required=True)
parser.add_argument("--adapter", type=Path, required=True)
parser.add_argument("--variant", choices=["baseline", "candidate"], required=True)
parser.add_argument("--fixture", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
here = Path(__file__).resolve().parent
args.output.mkdir(parents=True, exist_ok=True)
profile = args.output / ("electron-profile-" + args.variant)
profile.mkdir(exist_ok=True)
command = [
    "python3", str(here / "measure_tree.py"), "--output", str(args.output / ("electron-" + args.variant + "-rss.json")),
    "--timeout", "120", "--", "xvfb-run", "-a", str(args.electron.resolve()),
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", str(here / "electron_transport.mjs"),
    args.variant, str(args.adapter.resolve()), str(args.fixture.resolve()),
    args.fixture.with_suffix(".sha256").read_text().strip(),
    str(args.output / ("electron-" + args.variant + ".json")), str(profile.resolve()),
]
raise SystemExit(subprocess.run(command).returncode)
