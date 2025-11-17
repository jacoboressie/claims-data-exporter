#!/bin/bash

# Package Chrome Extension for Distribution
# This creates a .zip file ready for Chrome Web Store or manual distribution

set -e

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": "\(.*\)".*/\1/')
OUTPUT_FILE="claims-data-exporter-v${VERSION}.zip"

echo "📦 Packaging Claims Data Exporter Extension"
echo "Version: $VERSION"
echo "Output: $OUTPUT_FILE"
echo ""

# Check if all required files exist
REQUIRED_FILES=(
  "manifest.json"
  "popup.html"
  "popup.js"
  "content-script.js"
  "background.js"
  "injected.js"
  "icons/icon16.png"
  "icons/icon48.png"
  "icons/icon128.png"
)

echo "✓ Checking required files..."
for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "❌ Missing required file: $file"
    exit 1
  fi
  echo "  ✓ $file"
done

echo ""
echo "📦 Creating zip file..."

# Remove old zip if it exists
if [ -f "$OUTPUT_FILE" ]; then
  rm "$OUTPUT_FILE"
  echo "  ✓ Removed old version"
fi

# Create zip file
zip -r "$OUTPUT_FILE" \
  manifest.json \
  popup.html \
  popup.js \
  content-script.js \
  background.js \
  injected.js \
  icons/ \
  README.md \
  -x "*.DS_Store" "*.git*" "*.sh" "test-*" "claimwizard-export-*"

echo ""
echo "✅ Extension packaged successfully!"
echo ""
echo "📂 File: $OUTPUT_FILE"
echo "📏 Size: $(du -h "$OUTPUT_FILE" | cut -f1)"
echo ""
echo "📋 Next steps:"
echo ""
echo "For Testing:"
echo "  1. Open Chrome and go to chrome://extensions/"
echo "  2. Enable 'Developer mode'"
echo "  3. Click 'Load unpacked'"
echo "  4. Select this directory: $(pwd)"
echo ""
echo "For Distribution (Chrome Web Store):"
echo "  1. Go to https://chrome.google.com/webstore/devconsole"
echo "  2. Upload: $OUTPUT_FILE"
echo "  3. Fill in store listing details"
echo "  4. Submit for review"
echo ""
echo "For Manual Distribution:"
echo "  1. Share the .zip file with users"
echo "  2. Users unzip the file"
echo "  3. Users load unpacked extension in Chrome"
echo ""

