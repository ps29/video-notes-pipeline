#!/usr/bin/env python3
"""Transcribe an audio file. Prints plain text to stdout and writes <audio>.segments.json.

Two backends, picked automatically:
  1. whisper.cpp built with Vulkan (GPU) -- used if tools/whisper.cpp has been built
     by setup-whisper.ps1. Fast, and works on AMD/Intel/NVIDIA GPUs.
  2. faster-whisper (pip install faster-whisper) -- CPU fallback, no build step.
Set WHISPER_BACKEND=faster-whisper (or whisper.cpp) to force one.
"""
import sys
import os
import json
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
WHISPER_CLI = os.path.join(ROOT, "tools", "whisper.cpp", "build", "bin", "Release", "whisper-cli.exe")
MODELS_DIR = os.path.join(ROOT, "tools", "whisper.cpp", "models")


# Accuracy order of the whisper.cpp model families, least to most accurate.
FAMILIES = ["tiny", "base", "small", "medium", "large-v1", "large-v2", "large-v3-turbo", "large-v3"]


def model_rank(name):
    """Sort key for ggml-<family>[.en][-qN_M].bin: bigger family first, then English-only
    (better for English lectures), then full precision over q8 over q5. None if unrecognized."""
    import re
    m = re.match(r"^ggml-([a-z0-9-]+?)(\.en)?(?:-q(\d)_\d)?\.bin$", name)
    if not m or m.group(1) not in FAMILIES:
        return None
    return (FAMILIES.index(m.group(1)), bool(m.group(2)), int(m.group(3) or 99))


def find_model():
    """WHISPER_MODEL if set (a path, or a file name in MODELS_DIR), else the most accurate
    ggml model downloaded."""
    override = os.environ.get("WHISPER_MODEL")
    if override:
        return override if os.path.dirname(override) else os.path.join(MODELS_DIR, override)
    if os.path.isdir(MODELS_DIR):
        ranked = sorted((r, n) for n in os.listdir(MODELS_DIR) if (r := model_rank(n)) is not None)
        if ranked:
            return os.path.join(MODELS_DIR, ranked[-1][1])
    return os.path.join(MODELS_DIR, "ggml-small.en.bin")  # not present; reported by the caller


MODEL = find_model()


def transcribe_whisper_cpp(audio_path):
    print(f"Transcribing {audio_path} on GPU (whisper.cpp)...", file=sys.stderr)
    with tempfile.TemporaryDirectory() as tmp:
        out_base = os.path.join(tmp, "out")
        result = subprocess.run(
            [WHISPER_CLI, "-m", MODEL, "-f", audio_path, "-l", "en",
             "-oj", "-of", out_base, "-pp"],
            # stderr passes through so callers (the GUI log) see whisper.cpp's progress
            stdout=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            sys.exit(result.returncode)
        with open(out_base + ".json", encoding="utf-8") as f:
            data = json.load(f)

    return [
        {
            "start": s["offsets"]["from"] / 1000,
            "end": s["offsets"]["to"] / 1000,
            "text": s["text"].strip(),
        }
        for s in data["transcription"]
    ]


def transcribe_faster_whisper(audio_path):
    from faster_whisper import WhisperModel

    # base.en downloads on first run, then is cached. Use "small.en"/"medium.en" for accuracy.
    print("Loading faster-whisper model (CPU)...", file=sys.stderr)
    # cpu_threads defaults to 4; raise it to your physical core count
    model = WhisperModel("base.en", device="cpu", compute_type="int8",
                         cpu_threads=min(16, os.cpu_count() or 4))

    print(f"Transcribing {audio_path} on CPU (faster-whisper)...", file=sys.stderr)
    segments, _info = model.transcribe(audio_path, language="en", beam_size=1, vad_filter=True)
    return [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segments]


def pick_backend():
    forced = os.environ.get("WHISPER_BACKEND", "").lower()
    if forced in ("whisper.cpp", "faster-whisper"):
        return forced
    if os.path.exists(WHISPER_CLI) and os.path.exists(MODEL):
        return "whisper.cpp"
    return "faster-whisper"


def check():
    """Prints, as JSON, which backend and model a transcription would use (for deps-check.js)."""
    import importlib.util
    models = []
    if os.path.isdir(MODELS_DIR):
        models = [{"name": n, "size": os.path.getsize(os.path.join(MODELS_DIR, n))}
                  for n in sorted(os.listdir(MODELS_DIR)) if n.startswith("ggml-") and n.endswith(".bin")]
    print(json.dumps({
        "backend": pick_backend(),
        "whisper_cli": WHISPER_CLI,
        "whisper_cli_exists": os.path.exists(WHISPER_CLI),
        "model": MODEL,
        "model_exists": os.path.exists(MODEL),
        "models_dir": MODELS_DIR,
        "models": models,
        "faster_whisper": importlib.util.find_spec("faster_whisper") is not None,
    }))


def main():
    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <audio-file> | --check", file=sys.stderr)
        sys.exit(1)

    if sys.argv[1] == "--check":
        check()
        return

    audio_path = sys.argv[1]

    if not os.path.exists(audio_path):
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    backend = pick_backend()
    if backend == "whisper.cpp":
        for p in (WHISPER_CLI, MODEL):
            if not os.path.exists(p):
                print(f"Missing {p} -- run setup-whisper.ps1, or use faster-whisper", file=sys.stderr)
                sys.exit(1)
        segments = transcribe_whisper_cpp(audio_path)
    else:
        try:
            segments = transcribe_faster_whisper(audio_path)
        except ImportError:
            print("No Whisper backend available. Either run setup-whisper.ps1 (GPU, whisper.cpp) "
                  "or `pip install faster-whisper` (CPU).", file=sys.stderr)
            sys.exit(1)

    # Timed segments, used to match screenshots to what was being said
    segments_path = os.path.splitext(audio_path)[0] + ".segments.json"
    with open(segments_path, "w", encoding="utf-8") as f:
        json.dump(segments, f, indent=2)

    # Print to stdout so Node.js can capture it
    sys.stdout.reconfigure(encoding="utf-8")
    print("\n".join(s["text"] for s in segments))


if __name__ == "__main__":
    main()
