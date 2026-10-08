#!/usr/bin/env bash
# Prepares a macOS runner to sign and notarize the desktop app.
#
# Reads MAC_CSC_LINK (base64 .p12), MAC_CSC_KEY_PASSWORD, APPLE_API_KEY_P8_BASE64,
# APPLE_API_KEY_ID and APPLE_API_ISSUER; refuses when any is missing. Imports the
# Developer ID certificate into a temporary keychain (used to sign the DMG),
# writes the notary key, and exports the notarization environment through
# $GITHUB_ENV. electron-builder still gets the certificate as CSC_LINK /
# CSC_KEY_PASSWORD in the packaging step's own env.
set -euo pipefail

for name in MAC_CSC_LINK MAC_CSC_KEY_PASSWORD APPLE_API_KEY_P8_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!name:-}" ]; then
    echo "macOS signing secret for $name is missing; refusing to build an unsigned app." >&2
    exit 1
  fi
done

key="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode > "$key"
chmod 600 "$key"

keychain="$RUNNER_TEMP/omnirush-signing.keychain-db"
keychain_password=$(openssl rand -hex 24)
cert="$RUNNER_TEMP/omnirush-signing.p12"
printf '%s' "$MAC_CSC_LINK" | base64 --decode > "$cert"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$cert" -k "$keychain" -P "$MAC_CSC_KEY_PASSWORD" -T /usr/bin/codesign >/dev/null
rm -f "$cert"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# Keep the login keychain searchable alongside the new one.
existing=$(security list-keychains -d user | sed -e 's/^ *"//' -e 's/" *$//')
# shellcheck disable=SC2086
security list-keychains -d user -s "$keychain" $existing
security find-identity -v -p codesigning "$keychain" | grep -q '"Developer ID Application: ' || {
  echo "The signing certificate holds no Developer ID Application identity." >&2
  exit 1
}

{
  echo "MACOS_NOTARIZE=true"
  echo "MACOS_SIGNING_KEYCHAIN=$keychain"
  echo "APPLE_API_KEY=$key"
  echo "APPLE_API_KEY_ID=$APPLE_API_KEY_ID"
  echo "APPLE_API_ISSUER=$APPLE_API_ISSUER"
} >> "$GITHUB_ENV"
