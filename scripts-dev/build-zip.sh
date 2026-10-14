#!/usr/bin/env bash
# Package the module for release: module.json at the zip root, no dev files.
set -euo pipefail

rm -f module.zip
zip -r module.zip module.json LICENSE README.md lang scripts styles templates
