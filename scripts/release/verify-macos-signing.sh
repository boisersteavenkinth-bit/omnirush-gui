#!/usr/bin/env bash
# Verifies the signed macOS output in <dist-dir> (apps/desktop/dist-electron):
# the packaged app, every DMG, and the app inside every updater zip must carry a
# Developer ID signature with the hardened runtime, pass Gatekeeper as
# "Notarized Developer ID", and hold a stapled ticket.
set -euo pipefail

dist="${1:?usage: verify-macos-signing.sh <dist-dir>}"
shopt -s nullglob

gatekeeper() {
  local out
  out=$(spctl "$@" 2>&1) || { echo "$out" >&2; return 1; }
  echo "$out"
  grep -q 'source=Notarized Developer ID' <<<"$out" || { echo "Gatekeeper source is not Notarized Developer ID" >&2; return 1; }
}

check_app() {
  local app="$1" details
  echo "== $app"
  codesign --verify --deep --strict --verbose=2 "$app"
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  grep -E '^(Identifier|Authority|TeamIdentifier|Timestamp|CodeDirectory)' <<<"$details"
  grep -q '^Authority=Developer ID Application' <<<"$details" || { echo "not Developer ID signed" >&2; return 1; }
  grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime' <<<"$details" || { echo "hardened runtime is off" >&2; return 1; }
  codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -p - || true
  gatekeeper -a -vv -t exec "$app"
  xcrun stapler validate "$app"
}

apps=("$dist"/mac*/*.app)
dmgs=("$dist"/*.dmg)
zips=("$dist"/*-mac-*.zip)
[ ${#apps[@]} -gt 0 ] || { echo "no packaged .app under $dist" >&2; exit 1; }
[ ${#dmgs[@]} -gt 0 ] || { echo "no .dmg under $dist" >&2; exit 1; }
[ ${#zips[@]} -gt 0 ] || { echo "no mac .zip under $dist" >&2; exit 1; }

for app in "${apps[@]}"; do check_app "$app"; done

for dmg in "${dmgs[@]}"; do
  echo "== $dmg"
  codesign --verify --strict --verbose=2 "$dmg"
  codesign -dv --verbose=4 "$dmg" 2>&1 | grep -E '^(Authority|TeamIdentifier|Timestamp)'
  gatekeeper -a -vv -t open --context context:primary-signature "$dmg"
  xcrun stapler validate "$dmg"
done

for zip in "${zips[@]}"; do
  echo "== $zip"
  out=$(mktemp -d)
  ditto -x -k "$zip" "$out"
  for app in "$out"/*.app; do check_app "$app"; done
  rm -rf "$out"
done
