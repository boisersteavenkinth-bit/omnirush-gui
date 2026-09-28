"""Generate an opaque upload body for the transport-only memory comparison."""
import argparse, hashlib
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("path", type=Path)
parser.add_argument("--bytes", type=int, default=32 * 1024 * 1024)
args = parser.parse_args()
if args.bytes < 1:
    parser.error("--bytes must be positive")
args.path.parent.mkdir(parents=True, exist_ok=True)
digest = hashlib.sha256()
written = 0
with args.path.open("wb") as output:
    while written < args.bytes:
        block = hashlib.shake_256(b"omnirush synthetic capture transport" + (written // 65536).to_bytes(8, "big")).digest(min(65536, args.bytes - written))
        output.write(block)
        digest.update(block)
        written += len(block)
args.path.with_suffix(".sha256").write_text(digest.hexdigest())
print(f"{written} bytes; sha256={digest.hexdigest()}")
