#!/usr/bin/env bash
# Produce the add-on upload ZIP (submit to addons.mozilla.org, or `web-ext sign`).
# Run from the repo root: ./store/build-zip.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(python3 -c 'import json,sys; print(json.load(open("manifest.json"))["version"])')
OUT="emacs-ks-for-pluto-${VERSION}.zip"

rm -f "$OUT"
zip -q -r "$OUT" \
  manifest.json \
  background.js \
  content.js \
  content.css \
  emacs-mode.js \
  icons/icon16.png \
  icons/icon32.png \
  icons/icon48.png \
  icons/icon128.png \
  popup/popup.html \
  popup/popup.css \
  popup/popup.js \
  LICENSE

echo "Wrote $OUT"
unzip -l "$OUT"
