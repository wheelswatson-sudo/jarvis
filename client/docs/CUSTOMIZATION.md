# Customization Guide

Your assistant is fully customizable. Here's how to reshape it to fit you.

## Change the Name

Re-run the installer:

```bash
bash install.sh
```

It'll ask for a new name. Config and history are preserved.

## Adjust Personality Dials

Four sliders (0-100):

```bash
<name> --set humor 90          # Wit frequency
<name> --set formality 60      # Protocol level
<name> --set proactivity 80    # Anticipation level
<name> --set honesty 100       # Directness
```

### What Each Does

**Humor** controls dry wit and sarcasm frequency.
- 0 = pure operational, no jokes
- 50 = occasional dry observations
- 75 = regular polite sarcasm (JARVIS default)
- 100 = constant dry commentary

**Formality** controls register and "sir" usage.
- 0 = casual, first-name basis
- 50 = professional but relaxed
- 80 = butler protocol
- 100 = Downton Abbey levels

**Proactivity** controls autonomous action.
- 0 = only responds when spoken to
- 50 = offers suggestions
- 70 = anticipates needs, prepares options
- 100 = acts first, explains later

**Honesty** controls directness.
- 50 = diplomatic, softens criticism
- 75 = balanced
- 90 = direct with tact
- 100 = brutal honesty

## Change the Voice

List available voices:

```bash
<name> --voices
```

Switch:

```bash
<name> --voice <voice_id>
```

Recommended for a JARVIS-like voice:
- **George** (British, warm) — default
- **Daniel** (British, formal broadcaster)
- **Brian** (American, deep, resonant)
- **Eric** (American, smooth, trustworthy)

Or clone your own voice on [ElevenLabs](https://elevenlabs.io) and use that voice ID.

## Rewrite the Personality Entirely

Edit `~/.claude/personality.md`. Claude Code reads this on every session.

You could turn JARVIS into:
- A no-nonsense drill sergeant
- A warm, encouraging coach
- A Stoic philosopher
- A hyperactive startup bro
- Whatever you want

The personality file is plain markdown. Rewrite it. Save it. Start a new Claude session. Done.

## Change the Welcome Flow

Edit `~/.claude/WELCOME.md` — the script your assistant follows on first run.

## Change the Voice Output Behavior

### Auto-speak responses

When voice is `on`, Claude Code's Stop hook fires `~/.{name}/hooks/{name}-speak-hook.sh` after every response. The hook checks voice state and speaks if allowed.

To disable auto-speak entirely (while keeping the `{name}` command):

```bash
# Edit ~/.claude/settings.json, remove the Stop hook entry
```

### Filter what gets spoken

When voice is `auto`, the hook filters:
- Skips responses mostly containing code
- Skips very short responses
- Skips file listings

To customize, edit `~/.{name}/hooks/{name}-speak-hook.sh`.

## Add Custom Commands

You can add any custom command to `~/.{name}/bin/`. As long as it's in the path, you can use it.

Examples:
- `{name}-note "quick thought"` → saves to a log
- `{name}-todo "feature idea"` → adds to a todo list
- `{name}-git-status` → speaks your git status

## Add Integrations (MCP Servers)

Your assistant can connect to external services via MCP (Model Context Protocol):

- Gmail, Google Calendar, Drive
- iMessage, Contacts
- Spotify
- GitHub, Linear, Notion, Slack
- Custom APIs

See the Claude Code documentation for MCP setup: [https://docs.claude.com/claude-code](https://docs.claude.com/claude-code)

## Memory & Learning

Your assistant maintains memory in `~/.claude/memory/`. Files here are read on every session.

Tell your assistant:
> "Remember that I prefer X over Y."
> "Add to my memory: I always deploy on Fridays."

It'll write to the appropriate memory file.

## Uninstall

```bash
# Remove runtime
rm -rf ~/.{name}

# Remove Claude Code personality
rm ~/CLAUDE.md ~/.claude/personality.md ~/.claude/WELCOME.md

# Remove PATH entry from shell config
# (edit ~/.zshrc or ~/.bashrc and delete the "# <name> Voice Assistant" section)

# Remove Stop hook
# (edit ~/.claude/settings.json and remove the hook entry)
```

Done. No traces.
