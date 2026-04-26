#!/usr/bin/env bash
# JARVIS — One-line installer
# curl -fsSL https://raw.githubusercontent.com/<user>/jarvis/main/install.sh | bash
set -euo pipefail

ASSISTANT_DIR="$HOME/.jarvis"
REPO_URL="${JARVIS_REPO_URL:-https://github.com/<user>/jarvis}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}"
cat << 'BANNER'
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝
BANNER
echo -e "${NC}"
echo -e "  ${BOLD}Installing JARVIS...${NC}"
echo ""

# ─── Check dependencies ───────────────────────────────────────────────
check_dep() {
    if ! command -v "$1" &>/dev/null; then
        echo -e "  ${RED}Missing: $1${NC}"
        echo -e "  Install it: $2"
        return 1
    fi
    echo -e "  ${GREEN}Found: $1${NC}"
    return 0
}

deps_ok=true
check_dep "python3" "brew install python3 / apt install python3" || deps_ok=false
check_dep "curl" "brew install curl / apt install curl" || deps_ok=false

# Check for audio player
if command -v afplay &>/dev/null; then
    echo -e "  ${GREEN}Found: afplay (macOS)${NC}"
elif command -v mpv &>/dev/null; then
    echo -e "  ${GREEN}Found: mpv${NC}"
else
    echo -e "  ${RED}No audio player found. Install mpv: brew install mpv / apt install mpv${NC}"
    deps_ok=false
fi

if [[ "$deps_ok" == "false" ]]; then
    echo -e "\n  ${RED}Please install missing dependencies and try again.${NC}"
    exit 1
fi

echo ""

# ─── Install files ────────────────────────────────────────────────────
mkdir -p "$ASSISTANT_DIR/bin" "$ASSISTANT_DIR/config" "$ASSISTANT_DIR/cache" "$ASSISTANT_DIR/hooks"

# If running from cloned repo, copy everything in bin/ — not just jarvis.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/bin" ]]; then
    echo -e "  ${CYAN}Installing from local files...${NC}"
    cp "$SCRIPT_DIR"/bin/* "$ASSISTANT_DIR/bin/"
    cp -R "$SCRIPT_DIR"/hooks/* "$ASSISTANT_DIR/hooks/" 2>/dev/null || true
    cp "$SCRIPT_DIR/config/personality.md" "$ASSISTANT_DIR/config/personality.md"
else
    echo -e "  ${CYAN}Downloading from repository...${NC}"
    for f in jarvis jarvis-boot jarvis-converse jarvis-listen jarvis-setup jarvis-wake wake-listener.py; do
        curl -fsSL "$REPO_URL/raw/main/bin/$f" -o "$ASSISTANT_DIR/bin/$f"
    done
    curl -fsSL "$REPO_URL/raw/main/hooks/jarvis-speak-hook.sh" -o "$ASSISTANT_DIR/hooks/jarvis-speak-hook.sh"
    curl -fsSL "$REPO_URL/raw/main/config/personality.md" -o "$ASSISTANT_DIR/config/personality.md"
fi

chmod +x "$ASSISTANT_DIR"/bin/* 2>/dev/null || true
chmod +x "$ASSISTANT_DIR"/hooks/*.sh 2>/dev/null || true

# ─── Add to PATH ──────────────────────────────────────────────────────
SHELL_RC=""
if [[ -f "$HOME/.zshrc" ]]; then
    SHELL_RC="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
    SHELL_RC="$HOME/.bashrc"
elif [[ -f "$HOME/.bash_profile" ]]; then
    SHELL_RC="$HOME/.bash_profile"
fi

PATH_LINE='export PATH="$HOME/.jarvis/bin:$PATH"'
ENV_LINE='export ASSISTANT_DIR="$HOME/.jarvis"'

if [[ -n "$SHELL_RC" ]]; then
    if ! grep -q ".jarvis/bin" "$SHELL_RC" 2>/dev/null; then
        echo "" >> "$SHELL_RC"
        echo "# JARVIS Voice Assistant" >> "$SHELL_RC"
        echo "$ENV_LINE" >> "$SHELL_RC"
        echo "$PATH_LINE" >> "$SHELL_RC"
        echo -e "  ${GREEN}Added to PATH via $SHELL_RC${NC}"
    else
        echo -e "  ${GREEN}Already in PATH${NC}"
    fi
fi

# Export for current session
export PATH="$ASSISTANT_DIR/bin:$PATH"
export ASSISTANT_DIR="$ASSISTANT_DIR"

echo ""
echo -e "  ${GREEN}${BOLD}Installation complete.${NC}"
echo ""
echo -e "  Next step: run ${CYAN}jarvis-setup${NC} to configure your API key and voice."
echo ""
echo -e "  If the command isn't found, run:"
echo -e "  ${CYAN}source $SHELL_RC${NC}"
echo ""
