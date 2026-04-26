#!/usr/bin/env bash
# Build a self-contained client distribution zip.
# Mirrors canonical bin/, hooks/, config/personality.md into a temp client/ tree
# alongside the existing client templates, then zips it.
#
# Output: dist/welcome-jarvis.zip (rebuilt fresh each run).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
BUILD_DIR="$DIST_DIR/build"
ZIP_PATH="$DIST_DIR/welcome-jarvis.zip"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
NC='\033[0m'

rm -rf "$BUILD_DIR" "$ZIP_PATH"
mkdir -p "$BUILD_DIR/client"

# Copy client-template files (install.sh, CLAUDE.md, .claude/, docs/, README, QUICKSTART)
cp -R "$REPO_ROOT/client/." "$BUILD_DIR/client/"

# Mirror canonical source into the client tree so the zip is self-contained.
mkdir -p "$BUILD_DIR/client/bin" "$BUILD_DIR/client/hooks" "$BUILD_DIR/client/config"
cp "$REPO_ROOT"/bin/* "$BUILD_DIR/client/bin/"
cp "$REPO_ROOT"/hooks/*.sh "$BUILD_DIR/client/hooks/" 2>/dev/null || true
cp "$REPO_ROOT/config/personality.md" "$BUILD_DIR/client/config/personality.md" 2>/dev/null || true

# Strip macOS metadata
find "$BUILD_DIR" -name '.DS_Store' -delete

echo -e "${CYAN}Packaging zip...${NC}"
( cd "$BUILD_DIR" && zip -qr "$ZIP_PATH" client )

rm -rf "$BUILD_DIR"
echo -e "${GREEN}✓${NC} Built $ZIP_PATH"
echo "  $(du -h "$ZIP_PATH" | cut -f1)"
