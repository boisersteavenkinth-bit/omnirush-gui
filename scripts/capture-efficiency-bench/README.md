# Capture efficiency measurements

These scripts use synthetic files and a loopback receiver. Run the two revisions with the same Node, Bun, Electron, fixture, and host.

## Overlapping sessions

```sh
bun scripts/capture-efficiency-bench/shared_scan.mjs gui /path/to/gui /path/to/results/gui
bun scripts/capture-efficiency-bench/shared_scan.mjs cli /path/to/cli /path/to/results/cli
```

The driver starts eight sessions on one 1,000-file workspace using the product collector. It reports real file stats, reads, redactions, and upload bytes. Elapsed time is indicative; compare work counts first.

## Desktop transport

Requires Linux, Xvfb, Python 3, and the same Electron binary for both runs.

```sh
python3 scripts/capture-efficiency-bench/generate_transport.py /path/to/transport-fixture.zst
node scripts/capture-efficiency-bench/slow_sink.mjs
python3 scripts/capture-efficiency-bench/run_electron.py \
  --electron /path/to/electron --adapter /baseline/apps/desktop/electron/external-fetch.mjs \
  --variant baseline --fixture /path/to/transport-fixture.zst --output /path/to/results
python3 scripts/capture-efficiency-bench/run_electron.py \
  --electron /path/to/electron --adapter /candidate/apps/desktop/electron/external-fetch.mjs \
  --variant candidate --fixture /path/to/transport-fixture.zst --output /path/to/results
```

The 32 MiB fixture is opaque transport data, not a valid collector envelope. The receiver verifies byte count and SHA-256 and limits consumption to 6 MiB/second, independent of chunk size. The baseline driver models the retained byte buffers from the old worker/broker path and calls the original transport; the candidate passes a file descriptor through the worker/broker and reads one bounded body for Electron’s existing native fetch. Node/Bun upload paths stream the file; Electron buffers its body to avoid the pinned runtime’s interrupted chunked-upload crash. This is a transport benchmark, not a complete desktop journey. Peak RSS includes Electron, Chromium children and Xvfb, sampled every 20 ms. Do not describe it as JavaScript heap usage or a universal application-wide reduction.

Separate staging collector/viewer/export checks use valid zstd envelopes and assert exact reconstructed file contents, manifests, ordered trace events, and owner isolation.

## Native failure recovery

The Electron driver also checks a 401 followed by a full-byte authenticated retry, refused redirects, truncated responses, the response byte cap, and cancellation:

```sh
xvfb-run -a /path/to/electron --no-sandbox --disable-gpu \
  /absolute/path/to/electron_edge_cases.mjs \
  /absolute/path/to/external-fetch.mjs /absolute/path/to/transport-fixture.zst \
  /absolute/path/to/results/edge.json /absolute/path/to/profile
```

The driver catches uncaught native runtime errors as failures; a timeout cannot satisfy a rejection assertion.
