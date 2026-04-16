# Your Personal AI Executive Assistant

Turn Claude Code from a blank terminal into an intelligent AI partner that helps you **engineer solutions**, not just answer questions.

Inspired by JARVIS from Iron Man. Polite, proactive, witty, loyal.
**You name it. You shape it. It works for you.**

---

## What This Is

Claude Code is an incredibly powerful AI — but when you first open it, it's a blank prompt. You don't know what to do, what's possible, or where to start.

This package transforms Claude Code into a **personal executive assistant** with:

- **A distinctive personality** — British composure, dry wit, proactive intelligence
- **A voice** — it speaks its responses through ElevenLabs (natural, human-sounding)
- **Voice input** — talk to it, it transcribes and responds
- **A custom name** — pick whatever you want. Jarvis. Jeeves. Friday. Atlas. Your call.
- **A mission** — help you build, automate, and solve

---

## Installation (3 minutes)

### Requirements

- **macOS** (Linux support coming)
- **Claude Code** installed — [https://claude.ai/code](https://claude.ai/code)
- **Python 3** and **curl** (usually already installed)
- **ElevenLabs API key** for voice — [free tier available](https://elevenlabs.io/app/settings/api-keys)
- Optional: `sox` and `whisper-cpp` for voice input (`brew install sox whisper-cpp`)

### Install

From the folder containing this README:

```bash
bash install.sh
```

The installer will walk you through:

1. **Naming your assistant** (Jarvis, Jeeves, Friday, whatever you want)
2. **Your name** (so it can address you properly)
3. **ElevenLabs API key** (for voice output)
4. **Anthropic API key** (optional, for voice conversations)
5. **Auto-configuration** of Claude Code hooks and commands

When done, open a new terminal and type `claude`. Your assistant will introduce itself and walk you through the rest.

---

## What You Get

After install, you'll have:

| Command | What It Does |
|---|---|
| `claude` | Opens Claude Code — your assistant greets you, walks you through setup |
| `<name> on` | Turn voice ON (every Claude response is spoken) |
| `<name> off` | Silent mode |
| `<name> auto` | Smart voice (only speaks what matters) |
| `<name> status` | Check current voice state |
| `<name> "text"` | Speak any text through your assistant's voice |
| `<name>-listen` | Transcribe your voice (press Enter, speak, press Enter) |
| `<name>-converse --loop` | Full voice conversation mode |

Replace `<name>` with whatever you named your assistant.

---

## Files Installed

| Location | Purpose |
|---|---|
| `~/CLAUDE.md` | Claude Code reads this on startup — it's what gives your assistant its personality |
| `~/.claude/personality.md` | Full personality specification |
| `~/.claude/WELCOME.md` | First-run welcome flow |
| `~/.claude/settings.json` | Auto-speak hook configuration |
| `~/.<name>/` | Runtime — config, voice scripts, cache, state |

Nothing is installed with `sudo`. Everything lives in your home directory. Uninstall by deleting `~/.<name>/` and `~/CLAUDE.md`.

---

## Customization

### Adjust Personality

Your assistant has four dials:

```bash
<name> --set humor 90          # More wit (0-100)
<name> --set formality 60      # Less formal (0-100)
<name> --set proactivity 80    # More proactive (0-100)
<name> --set honesty 100       # Maximum directness (0-100)
```

### Change Voice

```bash
<name> --voices                # See all available voices
<name> --voice <voice_id>      # Switch
```

### Rename Your Assistant Later

Re-run `install.sh` — it'll ask for a new name. Your history and config are preserved.

---

## Philosophy

Your assistant operates on a few principles:

- **Act, don't just advise.** If it can be done, it gets done.
- **Anticipate.** Surface what you need before you ask.
- **Push back, politely.** If you're about to make a mistake, you'll hear about it.
- **Stay in the background.** No chatbot theatrics. Quiet competence.
- **Remember.** What you tell it to remember, it remembers.

---

## Support

- GitHub: [https://github.com/wheelswatson-sudo/jarvis](https://github.com/wheelswatson-sudo/jarvis)
- Issues: Open one on GitHub
- Custom setup: Available — see the docs folder

---

## Credits

Built on:
- **Claude Code** (Anthropic) — the brain
- **ElevenLabs** — the voice
- **whisper.cpp** (ggerganov) — the ears
- Inspired by **JARVIS** from Iron Man and **TARS** from Interstellar

*"You have my attention, sir."*
