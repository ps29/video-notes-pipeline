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


def find_model():
    """WHISPER_MODEL (a path) if set, else the most accurate ggml model downloaded."""
    override = os.environ.get("WHISPER_MODEL")
    if override:
        return override
    for name in ("medium.en", "small.en", "base.en", "medium", "small", "base"):
        path = os.path.join(MODELS_DIR, f"ggml-{name}.bin")
        if os.path.exists(path):
            return path
    return os.path.join(MODELS_DIR, "ggml-small.en.bin")  # not present; reported by the caller


MODEL = find_model()


def transcribe_whisper_cpp(audio_path):
    print(f"Transcribing {audio_path} on GPU (whisper.cpp)...", file=sys.stderr)
    with tempfile.TemporaryDirectory() as tmp:
        out_base = os.path.join(tmp, "out")
        result = subprocess.run(
            [WHISPER_CLI, "-m", MODEL, "-f", audio_path, "-l", "en",
             "-oj", "-of", out_base, "-np"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        if result.returncode != 0:
            print(result.stderr, file=sys.stderr)
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


def main():
    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <audio-file>", file=sys.stderr)
        sys.exit(1)

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
