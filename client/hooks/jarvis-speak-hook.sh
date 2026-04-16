#!/usr/bin/env bash
# JARVIS Claude Code Hook — Auto-speaks assistant responses
# Install: Add to Claude Code settings.json as a "Stop" hook
#
# This hook receives the assistant's response via stdin when Claude Code
# finishes generating. If JARVIS voice is "on", it speaks the response.
# If "off", it does nothing. If "auto", it filters for important responses.

set -euo pipefail

JARVIS_DIR="${JARVIS_DIR:-$HOME/.jarvis}"
STATE_FILE="$JARVIS_DIR/state.json"
ENV_FILE="$JARVIS_DIR/config/.env"
CONFIG_FILE="$JARVIS_DIR/config/settings.json"
JARVIS_BIN="$JARVIS_DIR/bin/jarvis"

# Quick exit if JARVIS isn't installed
[[ -f "$JARVIS_BIN" ]] || exit 0
[[ -f "$STATE_FILE" ]] || exit 0

# Check voice state
voice_state=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('voice', 'off'))" 2>/dev/null || echo "off")

# If off, exit immediately (zero overhead)
[[ "$voice_state" == "off" ]] && exit 0

# Read the assistant's response from stdin
response=$(cat)

# Skip empty responses
[[ -z "$response" ]] && exit 0

# Parse the transcript from the hook input
# Claude Code Stop hook sends JSON with the conversation transcript
assistant_text=$(python3 -c "
import json, sys

try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)

# Extract the last assistant message
messages = data.get('messages', [])
if not messages:
    sys.exit(0)

last = messages[-1]
if last.get('role') != 'assistant':
    sys.exit(0)

# Get text content
content = last.get('content', '')
if isinstance(content, list):
    # Content blocks format
    texts = []
    for block in content:
        if isinstance(block, dict) and block.get('type') == 'text':
            texts.append(block.get('text', ''))
    content = ' '.join(texts)

if not content.strip():
    sys.exit(0)

# In auto mode, filter for important responses
voice_state = '$voice_state'
if voice_state == 'auto':
    # Skip if response is mostly code/technical output
    code_ratio = content.count('\`') / max(len(content), 1)
    if code_ratio > 0.1:
        sys.exit(0)
    # Skip very short responses (likely just confirmations)
    if len(content.strip()) < 30:
        sys.exit(0)
    # Skip if it's mostly a file listing or directory output
    if content.count('/') > 10:
        sys.exit(0)

# Truncate for speech (keep it reasonable)
if len(content) > 2000:
    content = content[:1990] + '... I shall spare you the remainder, sir.'

print(content)
" <<< "$response" 2>/dev/null) || exit 0

# Speak it (in background so we don't block Claude Code)
if [[ -n "$assistant_text" ]]; then
    "$JARVIS_BIN" "$assistant_text" &
fi

exit 0
