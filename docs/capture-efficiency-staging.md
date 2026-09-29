# Capture efficiency: staging results

Tested on the staging server with synthetic workspaces and isolated capture
services. This change is proposed for review; production is not deployed.

## Changes

- Rank files by current tool writes, reads, associated tests/configuration,
  git changes, ordinary sources and generated output before the content cap.
- Reuse overlapping file reads, scrubbing and hashes with robust
  size/mtime/ctime/inode/device signatures. Shared metadata has a bounded
  cache and expires with the workspace's last session.
- Negotiate canonical schema-3 traces and preserve schema-2 downgrade for
  older collectors. Keep ordered records and completed turns.
- Pass immutable compressed file descriptors through the capture worker and
  gateway broker, removing retained IPC byte copies.
- Stream Node/Bun requests; use one bounded body through Electron's existing
  native fetch, preserving its OS certificate verification and proxy behavior.
- Bound archive pending bytes and free disk headroom. Paused base/delta work
  resumes without losing sequence, parent links or binary content.

## Measurements

Eight sessions on the same 1,000-file workspace:

| Product work counter | Main | Candidate |
| --- | ---: | ---: |
| GUI file reads | 15,134 | 9,000 |
| GUI scrub/hash passes | 7,134 | 1,000 |
| CLI file reads | 15,176 | 9,000 |
| CLI scrub/hash passes | 7,176 | 1,000 |
| Logical scans / file stats in each version | 8 / 8,000 | 8 / 8,000 |
| Accepted start uploads in each version | 8 | 8 |

This fixture performs about 40.5% fewer file reads and 86% fewer scrub/hash
passes. It shares expensive work while maintaining each session's manifest.
The benchmark is work-count evidence; no general latency improvement is
claimed.

A 32 MiB desktop transport fixture, limited to 6 MiB/second by the receiver,
used Electron 43.2.0 and its Node 24.18.0:

| Whole Electron/Chromium/Xvfb process tree | Main | Candidate |
| --- | ---: | ---: |
| Peak RSS bytes | 722,776,064 | 662,482,944 |
| Upload milliseconds | 5,596 | 5,550 |
| Received bytes | 33,554,432 | 33,554,432 |

Peak memory is about 8.3% lower in this transport fixture. Both receivers
verified the identical SHA-256. The baseline driver models retained old
worker/broker buffers and calls the old transport; the candidate uses the
actual new file adapter. This is not a full desktop memory measurement.
Scripts, fixture generation and method are in
[scripts/capture-efficiency-bench](../scripts/capture-efficiency-bench/README.md).

Native staging checks passed for 401 then authenticated full-file retry,
redirect refusal, truncated response rejection, the 1 MiB response cap and
cancellation. The initially attempted chunked Electron net.request path
crashed inside the pinned runtime on interruption; the final implementation
uses the established net.fetch path. Desktop request bodies are buffered,
bounded at 64 MiB, and governed by collector concurrency.

## Data preservation and disk recovery

Actual staging API checks in the
[backend companion PR](https://github.com/omnirush-ai/omnirush-backend/pull/90)
preserve all six completed viewer turns, twelve ordered export records,
exact files/manifests, same-ID duplicate retry and owner isolation. Its
repeated-file fixture uses 66.0% less local storage with opt-in compaction and
11.7% less compressed trace wire. These are local fixture savings; S3 keeps
full envelopes.

Archive recovery tests on staging passed four cases: base pause/restart,
delta pause/restart with correct parent, disk exhaustion during packing, and
concurrent packing under one pending budget. Restored binary bytes match.

Defaults are a 256 MiB pending archive budget and 512 MiB free disk floor,
configurable with OMNIRUSH_ARCHIVE_PENDING_BYTE_BUDGET and
OMNIRUSH_ARCHIVE_MIN_FREE_DISK_BYTES. Reservation estimates are conservative;
large bases can pause until the budget or available space increases.
Encrypted archive and restore formats are preserved.

## Verification

The PR's published capture-efficiency HTTP journey is the runtime proof for
canonical traces, compatibility fallback, record ordering and separate
session/workspace data. Its original assertion records are bound to the
final PR commit.

Targeted staging checks passed for real nested tool-path evidence, same-size
restored-mtime replacement, explicit schema downgrade, shutdown/spool retry,
the existing delayed-turn diff regression, archive recovery and native
transport failure recovery. CLI capture integration selection: 37 passed.

The final six-suite staging selection recorded 253 passed, 1 optional-fixture
skip and 3 failures. Clean main at
d83e0566785e1b8e1dabba1da8530359fce258b1 reproduced the same unified-diff
timing failure and two archive folder-policy failures. The introduced
shutdown and delayed-turn regressions found during review were fixed and
passed on staging. The 60 MiB collector memory check also passed in the
final selection and its standalone control. Native adapter tests: 10 passed;
boundary guard tests: 11 passed; server typecheck: passed.
Recorded-provider replay requires an optional fixture directory and remains
a skip, not a pass. The staging host is Linux; Windows/macOS desktop
certificates and installer behavior require platform verification.
