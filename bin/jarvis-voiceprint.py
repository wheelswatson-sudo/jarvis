#!/usr/bin/env python3
"""Voice fingerprinting — gate Jarvis on Watson's voice only.

Uses resemblyzer's pretrained speaker-encoder to extract a 256-dim embedding
from a chunk of audio, then cosine-compares the post-wake utterance to a
saved enrollment. If the score falls below the threshold, the utterance is
ignored — the wake word triggered, but the voice didn't match.

Setup:
    pip install resemblyzer --break-system-packages
    bin/jarvis-voiceprint.py --enroll      # records 10s of you speaking,
                                            saves to ~/.jarvis/voiceprint.npy

Verification (called by wake-listener.py after audio capture):
    from jarvis_voiceprint import verify   (via importlib)
    score = verify(audio_path)             # 0.0–1.0
    if score < threshold: ignore turn

Threshold default 0.75 — empirically the boundary above which same-speaker
matches dominate and below which different-speaker matches dominate, on the
GE2E loss this model was trained with. Override via JARVIS_VOICE_THRESHOLD.

resemblyzer not installed → all functions silently no-op (verify returns
None, wake-listener takes that as "no enrollment, allow turn").
"""
from __future__ import annotations

import os
import sys
import wave
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
VOICEPRINT_FILE = ASSISTANT_DIR / "voiceprint.npy"
VOICE_THRESHOLD = float(os.environ.get("JARVIS_VOICE_THRESHOLD", "0.75"))
ENROLL_SECONDS = 10
SAMPLE_RATE = 16000


def _try_import_resemblyzer():
    """Lazy import — resemblyzer pulls in torch which is heavy and may not be
    installable on every Python. Returns (VoiceEncoder, preprocess_wav, np)
    or (None, None, None) if anything fails."""
    try:
        import numpy as np  # type: ignore
        from resemblyzer import VoiceEncoder, preprocess_wav  # type: ignore
        return VoiceEncoder, preprocess_wav, np
    except Exception as e:
        sys.stderr.write(
            f"jarvis-voiceprint: resemblyzer unavailable ({e})\n"
            "  install: pip install resemblyzer --break-system-packages\n"
        )
        return None, None, None


_encoder = None


def _get_encoder():
    global _encoder
    if _encoder is not None:
        return _encoder
    VoiceEncoder, _, _ = _try_import_resemblyzer()
    if VoiceEncoder is None:
        return None
    try:
        _encoder = VoiceEncoder()
        return _encoder
    except Exception as e:
        sys.stderr.write(f"jarvis-voiceprint: encoder init failed ({e})\n")
        return None


def has_enrollment() -> bool:
    return VOICEPRINT_FILE.exists() and VOICEPRINT_FILE.stat().st_size > 0


def enroll(audio_path: str | Path | None = None) -> bool:
    """Save Watson's voice embedding. If audio_path is None, records 10s
    from the default mic. Returns True on success."""
    VoiceEncoder, preprocess_wav, np = _try_import_resemblyzer()
    if VoiceEncoder is None or np is None:
        return False

    tmp_to_clean: str | None = None
    if audio_path is None:
        try:
            import sounddevice as sd  # type: ignore
        except ImportError:
            sys.stderr.write("jarvis-voiceprint: sounddevice missing\n")
            return False
        print(f"Recording {ENROLL_SECONDS}s — speak naturally, sir.", flush=True)
        try:
            audio = sd.rec(
                int(ENROLL_SECONDS * SAMPLE_RATE),
                samplerate=SAMPLE_RATE, channels=1, dtype="int16",
            )
            sd.wait()
        except Exception as e:
            sys.stderr.write(f"jarvis-voiceprint: recording failed ({e})\n")
            return False
        # Write a temp WAV for resemblyzer's preprocess_wav
        import tempfile
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        with wave.open(tmp.name, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio.tobytes())
        audio_path = tmp.name
        tmp_to_clean = tmp.name

    try:
        encoder = _get_encoder()
        if encoder is None:
            return False
        try:
            wav = preprocess_wav(str(audio_path))
            emb = encoder.embed_utterance(wav)
        except Exception as e:
            sys.stderr.write(f"jarvis-voiceprint: embed failed ({e})\n")
            return False

        try:
            VOICEPRINT_FILE.parent.mkdir(parents=True, exist_ok=True)
            np.save(VOICEPRINT_FILE, emb)
        except OSError as e:
            sys.stderr.write(f"jarvis-voiceprint: save failed ({e})\n")
            return False

        print(f"Voice enrolled. I'll only respond to you now. (file: {VOICEPRINT_FILE})", flush=True)
        return True
    finally:
        if tmp_to_clean:
            try:
                os.unlink(tmp_to_clean)
            except OSError:
                pass


def verify(audio_path: str | Path) -> float | None:
    """Return cosine similarity vs the enrolled voiceprint, or None if
    voiceprint isn't enrolled or resemblyzer isn't available. Caller decides
    what to do — None means "no opinion, fail open."""
    if not has_enrollment():
        return None
    VoiceEncoder, preprocess_wav, np = _try_import_resemblyzer()
    if VoiceEncoder is None or np is None:
        return None
    encoder = _get_encoder()
    if encoder is None:
        return None
    try:
        target = np.load(VOICEPRINT_FILE)
        wav = preprocess_wav(str(audio_path))
        emb = encoder.embed_utterance(wav)
    except Exception as e:
        sys.stderr.write(f"jarvis-voiceprint: verify failed ({e})\n")
        return None

    # Cosine similarity. Both embeddings are L2-normalized by resemblyzer.
    try:
        score = float((target * emb).sum())
    except Exception:
        return None
    return score


def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args[0] == "--enroll":
        path = args[1] if len(args) > 1 else None
        return 0 if enroll(path) else 1
    if args[0] == "--verify":
        if len(args) < 2:
            sys.stderr.write("usage: jarvis-voiceprint --verify <audio.wav>\n")
            return 2
        score = verify(args[1])
        if score is None:
            print("no enrollment / library missing")
            return 2
        threshold = VOICE_THRESHOLD
        ok = score >= threshold
        print(f"score={score:.3f} threshold={threshold:.2f} match={ok}")
        return 0 if ok else 1
    sys.stderr.write(f"unknown command: {args[0]}\n")
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
