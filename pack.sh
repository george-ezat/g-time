#!/usr/bin/env bash
set -euo pipefail

# Package extension files for upload to extensions.gnome.org.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${SCRIPT_DIR}/g-time.zip"

cd "${SCRIPT_DIR}"
rm -f "${OUTPUT_FILE}"

zip -r "${OUTPUT_FILE}" *.js metadata.json stylesheet.css LICENSE

echo "Extension packaged successfully: ${OUTPUT_FILE}"