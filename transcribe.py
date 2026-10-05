#!/usr/bin/env python3
import sys
import os
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <audio-file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    if not os.path.exists(audio_path):
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    # Load model (base.en, downloads on first run, then cached)
    # For larger models, use "small.en", "medium.en", etc.
    print("Loading Whisper model...", file=sys.stderr)
    model = WhisperModel("base.en", device="cpu", compute_type="int8")

    print(f"Transcribing {audio_path}...", file=sys.stderr)
    segments, info = model.transcribe(audio_path, language="en")

    # Collect all transcript text
    transcript = "\n".join([segment.text for segment in segments])

    # Print to stdout so Node.js can capture it
    print(transcript)

if __name__ == "__main__":
    main()
