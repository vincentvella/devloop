#!/usr/bin/env bash
# Regenerate all icon assets from icon.svg. Run from anywhere: assets/build-icons.sh
set -euo pipefail
cd "$(dirname "$0")"

SVG=icon.svg
OUT=icons
rm -rf "$OUT" icon.iconset
mkdir -p "$OUT" icon.iconset

# Flat PNGs (used by Linux + electron-builder)
for sz in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$sz" -h "$sz" "$SVG" -o "$OUT/icon-${sz}.png"
done
cp "$OUT/icon-512.png" "$OUT/512x512.png"

# macOS .icns (Retina @2x variants)
rsvg-convert -w 16   -h 16   "$SVG" -o icon.iconset/icon_16x16.png
rsvg-convert -w 32   -h 32   "$SVG" -o icon.iconset/icon_16x16@2x.png
rsvg-convert -w 32   -h 32   "$SVG" -o icon.iconset/icon_32x32.png
rsvg-convert -w 64   -h 64   "$SVG" -o icon.iconset/icon_32x32@2x.png
rsvg-convert -w 128  -h 128  "$SVG" -o icon.iconset/icon_128x128.png
rsvg-convert -w 256  -h 256  "$SVG" -o icon.iconset/icon_128x128@2x.png
rsvg-convert -w 256  -h 256  "$SVG" -o icon.iconset/icon_256x256.png
rsvg-convert -w 512  -h 512  "$SVG" -o icon.iconset/icon_256x256@2x.png
rsvg-convert -w 512  -h 512  "$SVG" -o icon.iconset/icon_512x512.png
rsvg-convert -w 1024 -h 1024 "$SVG" -o icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

# Windows .ico (multi-size)
magick "$OUT/icon-16.png" "$OUT/icon-32.png" "$OUT/icon-48.png" "$OUT/icon-64.png" "$OUT/icon-128.png" "$OUT/icon-256.png" icon.ico

# Canonical single PNG for electron-builder auto-gen / docs
cp "$OUT/icon-1024.png" icon.png

echo "icons built → assets/{icon.icns, icon.ico, icon.png, icons/*.png}"
