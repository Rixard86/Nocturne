#!/usr/bin/env bash
# Collect the built APK into dist/ alongside the web source and install notes.
set -euo pipefail

cd "$(dirname "$0")/.."

APK="android/app/build/outputs/apk/debug/app-debug.apk"
STAGING="dist/nocturne-bundle"

test -f "$APK" || { echo "APK not found at $APK — run the build first" >&2; exit 1; }

rm -rf dist
mkdir -p "$STAGING"
cp "$APK" dist/nocturne-debug.apk
cp dist/nocturne-debug.apk "$STAGING/"
cp -r www "$STAGING/www"
cp README.md "$STAGING/"

cat > "$STAGING/INSTALL.txt" <<'TXT'
Nocturne — install instructions
1. Copy nocturne-debug.apk to your Android phone (or download it there).
2. Open the file; allow "Install unknown apps" when prompted.
3. Launch Nocturne, tap Record, grant the microphone permission.
   The "sample night" button works without the microphone.
Debug build for personal use. Screening aid, not a medical device.
TXT

ZIP_NAME="nocturne-bundle.zip"
case "${GITHUB_REF:-}" in
  refs/tags/*) ZIP_NAME="nocturne-${GITHUB_REF_NAME}.zip" ;;
esac

(cd "$STAGING" && zip -qr "../$ZIP_NAME" .)
rm -rf "$STAGING"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "ZIP_NAME=$ZIP_NAME" >> "$GITHUB_ENV"
fi

echo "==> dist/"
ls -la dist
