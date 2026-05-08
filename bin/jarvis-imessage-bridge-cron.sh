#!/usr/bin/env bash
# jarvis-imessage-bridge-cron.sh — cron-friendly wrapper for the iMessage
# bridge. Runs jarvis-imessage-bridge with a sensible default batch and a
# PATH that works under cron's stripped environment.
#
# Install (run once, from your shell):
#   crontab -l > /tmp/cron.tmp 2>/dev/null
#   echo '*/15 * * * * '"$HOME"'/jarvis/bin/jarvis-imessage-bridge-cron.sh' >> /tmp/cron.tmp
#   crontab /tmp/cron.tmp && rm /tmp/cron.tmp
#
# Logs land in ~/.jarvis/logs/imessage-bridge.log (the bridge writes there
# itself). This wrapper exists so cron doesn't need to know the absolute
# path to python3 or how to read ~/.jarvis/config/.env.
#
# The wrapper is intentionally NOT a long-lived process — each tick reads
# the bridge's watermark file and pushes only new messages, so 15-minute
# resolution costs ~one batch of new chat.db rows on the wire.

set -eu

# Cron's PATH is barebones (/usr/bin:/bin). Add the usual macOS Homebrew
# locations so `python3` is discoverable.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

# We deliberately do NOT source ~/.jarvis/config/.env here. The bridge has
# its own permissive parser (handles `export FOO=bar`, unbalanced quotes,
# and inline comments) — sourcing the same file in POSIX shell would crash
# on any line that's hand-edited slightly off-spec, even if the bridge can
# still read it. Letting the bridge own env loading keeps cron and manual
# runs reading the same effective config.

BRIDGE="$HOME/jarvis/bin/jarvis-imessage-bridge"
if [ ! -x "$BRIDGE" ]; then
  # Fallback to the worktree path if the user runs this from a checkout
  # rather than the installed ~/jarvis/bin location.
  BRIDGE="$(cd "$(dirname "$0")" && pwd)/jarvis-imessage-bridge"
fi

if [ ! -x "$BRIDGE" ]; then
  echo "jarvis-imessage-bridge-cron.sh: bridge not found or not executable" >&2
  exit 3  # EXIT_CONFIG, matches the bridge's own config-error code
fi

# --batch 200 matches the bridge's own DEFAULT_BATCH; explicit so changes
# to the bridge default don't silently retune cron behavior.
exec "$BRIDGE" --batch 200
