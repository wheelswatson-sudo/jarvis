#!/usr/bin/env bash
# Your AI Assistant — Interactive Installer
# Customizable JARVIS-style assistant. You pick the name.
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve canonical source for binaries/hooks/config.
# - When run from a packaged zip: $SCRIPT_DIR/bin, $SCRIPT_DIR/hooks, $SCRIPT_DIR/config exist.
# - When run from the dev repo: those live one level up at $SCRIPT_DIR/../{bin,hooks,config}.
if [[ -d "$SCRIPT_DIR/bin" ]]; then
    SRC_BIN="$SCRIPT_DIR/bin"
    SRC_HOOKS="$SCRIPT_DIR/hooks"
    SRC_CONFIG="$SCRIPT_DIR/config"
else
    SRC_BIN="$SCRIPT_DIR/../bin"
    SRC_HOOKS="$SCRIPT_DIR/../hooks"
    SRC_CONFIG="$SCRIPT_DIR/../config"
fi

clear
echo ""
echo -e "${CYAN}${BOLD}"
cat << 'BANNER'
   ╔═══════════════════════════════════════════════════╗
   ║     Your Personal AI Executive Assistant         ║
   ║          Powered by Claude + ElevenLabs           ║
   ╚═══════════════════════════════════════════════════╝
BANNER
echo -e "${NC}"
echo ""
echo -e "   ${DIM}Before we begin, I need a few things from you.${NC}"
echo -e "   ${DIM}This setup takes about 3 minutes.${NC}"
echo ""

# ─── Step 1: Name the assistant ───────────────────────────────────────
echo -e "${CYAN}${BOLD}Step 1 of 5:${NC} Name your assistant"
echo ""
echo -e "   ${DIM}This is the name it will respond to and introduce itself as.${NC}"
echo -e "   ${DIM}Examples: Jarvis, Jeeves, Friday, Atlas, Nova, Echo, Max${NC}"
echo ""
echo -n "   Name: "
read -r ASSISTANT_NAME

if [[ -z "$ASSISTANT_NAME" ]]; then
    ASSISTANT_NAME="Jarvis"
    echo -e "   ${YELLOW}Using default: Jarvis${NC}"
fi

# Slug for filenames and commands (lowercase, no spaces)
ASSISTANT_SLUG=$(echo "$ASSISTANT_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
if [[ -z "$ASSISTANT_SLUG" ]]; then
    ASSISTANT_SLUG="jarvis"
fi

echo ""
echo -e "   ${GREEN}→ ${ASSISTANT_NAME}${NC} ${DIM}(command: ${ASSISTANT_SLUG})${NC}"
echo ""

# ─── Step 2: User name ────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}Step 2 of 5:${NC} Your name"
echo ""
echo -e "   ${DIM}${ASSISTANT_NAME} will address you by this name when appropriate.${NC}"
echo ""
echo -n "   Your name: "
read -r USER_NAME
USER_NAME="${USER_NAME:-$(whoami)}"

echo ""
echo -e "   ${GREEN}→ ${USER_NAME}${NC}"
echo ""

# ─── Step 3: ElevenLabs key ───────────────────────────────────────────
echo -e "${CYAN}${BOLD}Step 3 of 5:${NC} ElevenLabs API key (voice)"
echo ""
echo -e "   ${DIM}For ${ASSISTANT_NAME} to speak aloud.${NC}"
echo -e "   ${DIM}Get a free key at: ${BLUE}https://elevenlabs.io/app/settings/api-keys${NC}"
echo -e "   ${DIM}Or press Enter to skip voice (you can add it later).${NC}"
echo ""
echo -n "   ElevenLabs API Key: "
read -r ELEVENLABS_KEY

# Validate if provided
if [[ -n "$ELEVENLABS_KEY" ]]; then
    echo -n "   Validating..."
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        "https://api.elevenlabs.io/v1/user" \
        -H "xi-api-key: ${ELEVENLABS_KEY}" 2>/dev/null || echo "000")

    if [[ "$http_code" == "200" ]]; then
        echo -e " ${GREEN}Valid!${NC}"
        VOICE_ENABLED="yes"
    else
        echo -e " ${YELLOW}Could not validate (HTTP $http_code). Saving anyway.${NC}"
        VOICE_ENABLED="yes"
    fi
else
    echo -e "   ${YELLOW}Skipping voice setup.${NC}"
    VOICE_ENABLED="no"
fi

echo ""

# ─── Step 4: Anthropic key ────────────────────────────────────────────
echo -e "${CYAN}${BOLD}Step 4 of 5:${NC} Anthropic API key (optional)"
echo ""
echo -e "   ${DIM}Only needed for ${ASSISTANT_SLUG}-converse voice conversations.${NC}"
echo -e "   ${DIM}Claude Code itself uses your Claude subscription.${NC}"
echo -e "   ${DIM}Get a key at: ${BLUE}https://console.anthropic.com/settings/keys${NC}"
echo ""
echo -n "   Anthropic API Key (optional): "
read -r ANTHROPIC_KEY
echo ""

# ─── Step 5: Install location ─────────────────────────────────────────
INSTALL_DIR="$HOME/.${ASSISTANT_SLUG}"
echo -e "${CYAN}${BOLD}Step 5 of 5:${NC} Installing to ${INSTALL_DIR}"
echo ""

# Check dependencies
echo -e "   ${DIM}Checking dependencies...${NC}"
for dep in python3 curl; do
    if ! command -v "$dep" &>/dev/null; then
        echo -e "   ${RED}Missing: $dep${NC}"
        echo -e "   Install with: ${CYAN}brew install $dep${NC}"
        exit 1
    fi
done

# Optional dependency warnings
if ! command -v rec &>/dev/null; then
    echo -e "   ${YELLOW}Note: sox not installed. Voice input disabled.${NC}"
    echo -e "   ${DIM}Install later: brew install sox${NC}"
fi
if ! command -v whisper-cli &>/dev/null && ! command -v whisper-cpp &>/dev/null; then
    echo -e "   ${YELLOW}Note: whisper-cpp not installed. Voice input disabled.${NC}"
    echo -e "   ${DIM}Install later: brew install whisper-cpp${NC}"
fi

echo -e "   ${GREEN}✓ Core dependencies present${NC}"
echo ""

# ─── Install files ────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/config" "$INSTALL_DIR/cache" "$INSTALL_DIR/hooks"

# Copy binaries (rename to user's chosen name)
for src_bin in "$SRC_BIN"/*; do
    if [[ -f "$src_bin" ]]; then
        bin_name=$(basename "$src_bin")
        # Replace "jarvis" with user's slug in filenames
        new_name="${bin_name//jarvis/$ASSISTANT_SLUG}"
        cp "$src_bin" "$INSTALL_DIR/bin/$new_name"

        # Replace references in script content. Note: ASSISTANT_DIR (the env var
        # name) intentionally contains no "JARVIS"/"Jarvis"/"jarvis" substring,
        # so this sed never mangles it. The internal var name stays consistent
        # across all installs regardless of brand.
        sed -i.bak "s/jarvis/$ASSISTANT_SLUG/g; s/JARVIS/$ASSISTANT_NAME/g; s/Jarvis/$ASSISTANT_NAME/g" "$INSTALL_DIR/bin/$new_name"
        rm -f "$INSTALL_DIR/bin/$new_name.bak"

        chmod +x "$INSTALL_DIR/bin/$new_name"
    fi
done

# Copy hooks
if [[ -d "$SRC_HOOKS" ]]; then
    cp "$SRC_HOOKS"/*.sh "$INSTALL_DIR/hooks/" 2>/dev/null || true
    # Rename + substitute in hooks too
    for hook_orig in "$INSTALL_DIR"/hooks/*.sh; do
        [[ -f "$hook_orig" ]] || continue
        hook_name=$(basename "$hook_orig")
        new_hook_name="${hook_name//jarvis/$ASSISTANT_SLUG}"
        if [[ "$hook_name" != "$new_hook_name" ]]; then
            mv "$hook_orig" "$INSTALL_DIR/hooks/$new_hook_name"
        fi
    done
    for hook in "$INSTALL_DIR"/hooks/*.sh; do
        [[ -f "$hook" ]] || continue
        sed -i.bak "s/jarvis/$ASSISTANT_SLUG/g; s/JARVIS/$ASSISTANT_NAME/g; s/Jarvis/$ASSISTANT_NAME/g" "$hook"
        rm -f "$hook.bak"
        chmod +x "$hook"
    done
fi

# Copy personality config with substitution. Prefer the templated client
# version (with {{PLACEHOLDERS}}); fall back to the canonical one.
if [[ -f "$SCRIPT_DIR/.claude/personality.md" ]]; then
    sed "s/{{ASSISTANT_NAME}}/$ASSISTANT_NAME/g; s/{{ASSISTANT_SLUG}}/$ASSISTANT_SLUG/g; s/{{USER_NAME}}/$USER_NAME/g" \
        "$SCRIPT_DIR/.claude/personality.md" > "$INSTALL_DIR/config/personality.md"
elif [[ -f "$SRC_CONFIG/personality.md" ]]; then
    cp "$SRC_CONFIG/personality.md" "$INSTALL_DIR/config/personality.md"
fi

# Write settings.json
cat > "$INSTALL_DIR/config/settings.json" << EOF
{
    "voice_id": "JBFqnCBsd6RMkjVDRZzb",
    "voice_name": "George",
    "model_id": "eleven_turbo_v2_5",
    "stability": 0.5,
    "similarity_boost": 0.85,
    "style": 0.2,
    "humor": 75,
    "formality": 80,
    "proactivity": 70,
    "honesty": 90,
    "assistant_name": "$ASSISTANT_NAME",
    "user_name": "$USER_NAME"
}
EOF

# Write .env
cat > "$INSTALL_DIR/config/.env" << EOF
# ${ASSISTANT_NAME} Configuration
ELEVENLABS_API_KEY=${ELEVENLABS_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_KEY:-}
ASSISTANT_NAME=${ASSISTANT_NAME}
ASSISTANT_SLUG=${ASSISTANT_SLUG}
USER_NAME=${USER_NAME}
EOF
chmod 600 "$INSTALL_DIR/config/.env"

# Initial state
cat > "$INSTALL_DIR/state.json" << EOF
{
    "voice": "${VOICE_ENABLED}",
    "welcomed": false,
    "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ─── Install Claude Code instructions ─────────────────────────────────
echo -e "   ${DIM}Installing Claude Code personality...${NC}"

mkdir -p "$HOME/.claude"

# CLAUDE.md (project-level — goes to user's home project)
if [[ -f "$SCRIPT_DIR/CLAUDE.md" ]]; then
    # If user already has a CLAUDE.md, back it up
    if [[ -f "$HOME/CLAUDE.md" ]]; then
        cp "$HOME/CLAUDE.md" "$HOME/CLAUDE.md.backup-$(date +%s)"
        echo -e "   ${YELLOW}Existing CLAUDE.md backed up${NC}"
    fi
    sed "s/{{ASSISTANT_NAME}}/$ASSISTANT_NAME/g; s/{{ASSISTANT_SLUG}}/$ASSISTANT_SLUG/g; s/{{USER_NAME}}/$USER_NAME/g" \
        "$SCRIPT_DIR/CLAUDE.md" > "$HOME/CLAUDE.md"
fi

# .claude/WELCOME.md and personality.md
mkdir -p "$HOME/.claude"
for template in "$SCRIPT_DIR"/.claude/*.md; do
    [[ -f "$template" ]] || continue
    tname=$(basename "$template")
    sed "s/{{ASSISTANT_NAME}}/$ASSISTANT_NAME/g; s/{{ASSISTANT_SLUG}}/$ASSISTANT_SLUG/g; s/{{USER_NAME}}/$USER_NAME/g" \
        "$template" > "$HOME/.claude/$tname"
done

# Install Stop hook into settings.json
HOOK_CMD="bash $INSTALL_DIR/hooks/${ASSISTANT_SLUG}-speak-hook.sh 2>/dev/null || true"

if [[ -f "$HOME/.claude/settings.json" ]]; then
    # Merge into existing
    python3 << PYEOF
import json, os
path = os.path.expanduser("~/.claude/settings.json")
with open(path) as f:
    settings = json.load(f)

if 'hooks' not in settings:
    settings['hooks'] = {}
if 'Stop' not in settings['hooks']:
    settings['hooks']['Stop'] = []

# Check if our hook is already there
has_hook = False
for entry in settings['hooks']['Stop']:
    for h in entry.get('hooks', []):
        if '${ASSISTANT_SLUG}-speak-hook' in h.get('command', ''):
            has_hook = True
            break

if not has_hook:
    settings['hooks']['Stop'].append({
        "hooks": [{
            "type": "command",
            "command": "$HOOK_CMD",
            "timeout": 30,
            "async": True
        }]
    })

with open(path, 'w') as f:
    json.dump(settings, f, indent=2)
PYEOF
else
    cat > "$HOME/.claude/settings.json" << EOF
{
    "hooks": {
        "Stop": [
            {
                "hooks": [
                    {
                        "type": "command",
                        "command": "${HOOK_CMD}",
                        "timeout": 30,
                        "async": true
                    }
                ]
            }
        ]
    }
}
EOF
fi

# ─── PATH setup ──────────────────────────────────────────────────────
SHELL_RC=""
if [[ -f "$HOME/.zshrc" ]]; then
    SHELL_RC="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
    SHELL_RC="$HOME/.bashrc"
fi

if [[ -n "$SHELL_RC" ]] && ! grep -q "${ASSISTANT_SLUG}/bin" "$SHELL_RC" 2>/dev/null; then
    cat >> "$SHELL_RC" << EOF

# ${ASSISTANT_NAME} Voice Assistant
export ASSISTANT_DIR="\$HOME/.${ASSISTANT_SLUG}"
export PATH="\$HOME/.${ASSISTANT_SLUG}/bin:\$PATH"
EOF
fi

# Export for this session
export PATH="$INSTALL_DIR/bin:$PATH"

# ─── Done ────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}   ✓ Installation complete, $USER_NAME.${NC}"
echo ""
echo -e "${CYAN}   Here's what was installed:${NC}"
echo ""
echo -e "   ${DIM}•${NC} ${ASSISTANT_SLUG} CLI               ${DIM}($INSTALL_DIR/bin/)${NC}"
echo -e "   ${DIM}•${NC} Claude Code personality  ${DIM}(~/CLAUDE.md, ~/.claude/)${NC}"
echo -e "   ${DIM}•${NC} Auto-speak hook          ${DIM}(~/.claude/settings.json)${NC}"
echo -e "   ${DIM}•${NC} Voice state: ${VOICE_ENABLED}"
echo ""
echo -e "${CYAN}   Next steps:${NC}"
echo ""
echo -e "   ${BOLD}1.${NC} Open a new terminal (or: ${CYAN}source $SHELL_RC${NC})"
echo -e "   ${BOLD}2.${NC} Run: ${CYAN}claude${NC}"
echo -e "      → ${ASSISTANT_NAME} will introduce himself and walk you through setup."
echo ""
echo -e "   ${DIM}Commands to remember:${NC}"
echo -e "   ${CYAN}${ASSISTANT_SLUG} on${NC}      Turn voice on"
echo -e "   ${CYAN}${ASSISTANT_SLUG} off${NC}     Turn voice off"
echo -e "   ${CYAN}${ASSISTANT_SLUG} status${NC}  Check voice state"
echo ""

# Test voice if enabled
if [[ "$VOICE_ENABLED" == "yes" ]]; then
    echo -e "   ${DIM}Let me introduce myself...${NC}"
    sleep 1
    "$INSTALL_DIR/bin/$ASSISTANT_SLUG" "Good day, $USER_NAME. I am $ASSISTANT_NAME. I am fully operational and at your disposal. Open Claude Code when you are ready and we shall begin." 2>/dev/null || true
fi

echo ""
