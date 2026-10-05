# Video → Study Notes Pipeline

A minimal Node.js pipeline that extracts audio from a video, transcribes it with free speech-to-text (faster-whisper), fixes transcription errors using Claude, and generates structured study notes.

## Prerequisites

- **Node.js** (v14+) — should already be installed
- **Python 3.7+** — should already be installed (confirmed: Python 3.14 available)
- **ffmpeg** — already confirmed installed on your system
- **Claude Code CLI** (`claude`) — must be installed and logged in with your Pro account
- **faster-whisper** — Python package (installs via `pip install faster-whisper`)

## Setup (one-time)

### 1. Install faster-whisper

```bash
pip install faster-whisper
```

On first run, the `base.en` model (~140 MB) will auto-download and be cached locally. No manual model file download needed.

### 2. Verify Claude CLI is ready

```bash
claude --version
```

Make sure you're logged in (you should be via your Claude Code Pro subscription).

## Usage

Run on a **single video**:

```bash
node process.js path\to\video.mp4
```

Or process an **entire folder** of videos:

```bash
node process.js C:\path\to\Videos
```

The script will automatically detect if the input is a folder or file:
- **Single file:** Processes that video, outputs `.raw.txt`, `.fixed.md`, `.notes.md` alongside it
- **Folder:** Lists all video files found, processes each one sequentially, shows a summary at the end

Supported formats: `.mp4`, `.mkv`, `.avi`, `.mov`, `.flv`, `.webm`, `.m4v`

## Examples

**Single video:**
```bash
node process.js "C:\Users\pssh\Downloads\OMSCS Fall 2026\lecture-01.mp4"
```

**Batch process entire folder:**
```bash
node process.js "C:\Users\pssh\Downloads\Videos"
```

Output per video:
- **`topic-title.md`** — single markdown file (filename reflects the core idea of the video)
  - Study notes with sections and key concepts at the top
  - Original transcript appended at the bottom (for reference)
- `lecture-01.wav` — extracted audio (kept for reference, can be deleted)

## How it works

### Stage 1: Audio Extraction
Uses ffmpeg to convert video to a 16 kHz mono WAV (optimal for speech recognition).

### Stage 2: Transcription
Uses faster-whisper (Python + PyTorch, local, no internet after model is cached) to transcribe audio to text.

### Stage 3: Transcript Correction
Sends raw transcript to Claude CLI, asking it to fix mis-transcribed CS terms using surrounding context (e.g., "algoritm" → "algorithm", "Pithon" → "Python").

### Stage 4: Study Notes & Final Markdown
Sends the corrected transcript to Claude CLI, asking for:
- A clear title reflecting the video's core topic (e.g., "# Distributed Systems Basics")
- Structured markdown with topic headings, key definitions, bullet-point summaries
- Code examples and video references throughout
- The filename is auto-generated from this title (e.g., `distributed-systems-basics.md`)
- Both the notes and original transcript are combined into this single markdown file

## Troubleshooting

**"ModuleNotFoundError: No module named 'faster_whisper'"**
- Run `pip install faster-whisper` (may take a minute, also installs PyTorch)

**"No module named 'torch'"**
- Ensure PyTorch is installed: `pip install torch` (faster-whisper should pull this in automatically)

**"Claude CLI failed"**
- Verify `claude --version` works and you're logged in

**"ffmpeg failed"**
- Ensure ffmpeg is on your system PATH

## Customization

Edit the prompts in `process.js` (in `fixTranscript()` and `generateNotes()`) to adjust correction and note-generation behavior.

For example:
- Change "computer science" to a specific domain if needed
- Add more detailed instructions for the note format
- Request code summaries, definitions tables, or other structures

## Future improvements

- Folder watching: auto-process new videos dropped in an input folder
- Batch mode: process multiple videos at once
- Speaker identification: handle multi-speaker lectures
- Persistence: track which videos have been processed
- Output formats: generate PDF, DOCX, or JSON in addition to markdown
