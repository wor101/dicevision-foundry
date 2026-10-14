#!/usr/bin/env bash
# Set module.json's version, manifest and download URLs for a release tag.
# Usage: scripts-dev/stamp-manifest.sh v0.1.1 wor101/dicevision-foundry
set -euo pipefail

tag="$1"
repo="$2"
version="${tag#v}"
base="https://github.com/${repo}/releases"

if [[ "$tag" == *-* ]]; then
  manifest="${base}/download/${tag}/module.json"   # pre-release: latest skips it
else
  manifest="${base}/latest/download/module.json"
fi
download="${base}/download/${tag}/module.zip"

VERSION="$version" MANIFEST="$manifest" DOWNLOAD="$download" node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("module.json", "utf8"));
  m.version = process.env.VERSION;
  m.manifest = process.env.MANIFEST;
  m.download = process.env.DOWNLOAD;
  fs.writeFileSync("module.json", JSON.stringify(m, null, 2) + "\n");
'
echo "module.json: version=${version}"
echo "  manifest=${manifest}"
echo "  download=${download}"
