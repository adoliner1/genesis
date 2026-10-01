#!/usr/bin/env bash
# Import a PixelLab character zip: tools/import_pixellab.sh <character.zip> <name>
# Needs `godot` on PATH (or GODOT=/path/to/godot).
set -euo pipefail
GODOT="${GODOT:-godot}"
cd "$(dirname "$0")/.."
"$GODOT" --headless --path . -s tools/import_pixellab.gd -- extract "$(realpath "$1")" "$2"
"$GODOT" --headless --path . --import >/dev/null 2>&1
"$GODOT" --headless --path . -s tools/import_pixellab.gd -- build "$2"
