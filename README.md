# Video → Study Notes Pipeline

A Node.js pipeline that turns lecture videos into self-contained markdown study notes. For each video it gets a transcript (from an existing `.srt` subtitle file, or by transcribing the audio locally with Whisper) and sends it to the Claude CLI to generate exam-oriented notes. With screenshots enabled (the default) it also picks the useful lecture frames, describes them with a local vision model, and produces a DOCX with the screenshots placed in the notes.

## Prerequisites

- **Node.js** (v16+)
- **ffmpeg** on PATH (audio extraction, and frame extraction for screenshots)
- **pandoc** on PATH (DOCX output when screenshots are enabled)
- **Claude Code CLI** (`claude`) installed and logged in
- **A Whisper backend** (only needed for videos without subtitles) — see below
- **Python 3** — `transcribe.py` is launched through `.venv\Scripts\python.exe`

```bash
python -m venv .venv
```

## Transcription setup (Whisper)

If your videos come with `.srt` subtitles (see [Subtitles](#subtitles)), you can skip this section. Otherwise pick **one** of the two backends. `transcribe.py` chooses automatically: whisper.cpp if it has been built, otherwise faster-whisper.

### Option A — whisper.cpp on the GPU (build it yourself)

```powershell
.\setup-whisper.ps1                    # small.en model
.\setup-whisper.ps1 -Model medium.en   # more accurate, slower
```

The script installs missing build tools with winget (Git, CMake, Vulkan SDK, Visual Studio 2022 Build Tools with the C++ workload — about 6 GB, and some installers ask for administrator approval), clones whisper.cpp into `tools\`, builds it with Vulkan, downloads the model, and runs a quick check that the GPU backend is actually used. It is safe to rerun. Use `-SkipInstall` if the tools are already installed.

#### Why build it ourselves?

- **There is no prebuilt Vulkan binary for Windows.** The whisper.cpp releases ship CPU, NVIDIA CUDA and Qualcomm Adreno builds only. The Vulkan backend (`-DGGML_VULKAN=1`) has to be compiled locally.
- **Vulkan is what makes the GPU usable on AMD and Intel hardware.** It works on any GPU with a Vulkan driver, including integrated GPUs that share system memory (for example the Radeon 8060S in a Ryzen AI Max+ 395).
- **The pip package can't use those GPUs.** faster-whisper's engine (CTranslate2) runs on CPU or NVIDIA CUDA only; it has no ROCm/Vulkan support on Windows. On an AMD or Intel machine, building whisper.cpp is the only way to get GPU transcription.

### Option B — faster-whisper from pip (no build)

```bash
.\.venv\Scripts\python.exe -m pip install faster-whisper
```

You can use this **instead of** building whisper.cpp. It runs on the CPU, needs no compiler, and the `base.en` model downloads automatically on first use. It is slower than the GPU build, but it works everywhere with a one-line install. (`transcribe.py` runs it on the CPU only; for an NVIDIA GPU, change `device="cpu"` in `transcribe_faster_whisper()`.)

To force a backend, set `WHISPER_BACKEND` to `whisper.cpp` or `faster-whisper`. To force a specific whisper.cpp model, set `WHISPER_MODEL` to the path of a `ggml-*.bin` file.

## Local frame analysis (optional)

With screenshots enabled, kept frames are also described by a local vision model via `frame_analyze.py`. It writes `descriptions.json` (a description plus on-screen text per frame) into the `-frames` folder, and the image-placement prompt uses it. Claude still classifies and captions the frames.

**Preferred: Lemonade Server** (AMD, good fit for Ryzen AI). Install it, start it, and pull a vision model: `lemonade pull Qwen3-VL-8B-Instruct-GGUF`. The script uses it automatically when it answers at `LEMONADE_URL` (default `http://localhost:13305/api/v1`). Pick another model with `LEMONADE_MODEL`.

**Fallback: llama.cpp.** If Lemonade isn't running, the script launches `llama-server` itself (Qwen2.5-VL-3B, Vulkan GPU). Run `.\setup-whisper.ps1` first (it installs the build tools), then `.\setup-llama.ps1`. Override with `VLM_MODEL` / `VLM_MMPROJ` (paths) or `LLAMA_SERVER`.

If neither is available, the stage logs a warning and the pipeline carries on with Claude's captions. You can also run it by hand on a frames folder, a video, or a folder of videos: `python frame_analyze.py <path>`.

## Usage

```bash
node process.js path\to\video.mp4          # one video
node process.js C:\path\to\Videos          # a folder, including all subfolders
```

Supported formats: `.mp4`, `.mkv`, `.avi`, `.mov`, `.flv`, `.webm`, `.m4v`

### Folders and subfolders

A folder is searched recursively. Every video's output is written **next to that video**, so each subfolder ends up with its own notes. Hidden folders and generated `*-frames` folders are skipped.

### Subtitles

For each video the pipeline looks for an `.srt` file named like the video, first in `<video folder>_subtitles\` and then beside the video:

```
Course\P1L1\10 - Overview.mp4
Course\P1L1_subtitles\10 - Overview.srt     <- used if present
```

When a subtitle file exists it is used as the transcript: audio extraction and Whisper are skipped, and the transcript-fix step is skipped too (subtitles are already clean). Videos without subtitles go through ffmpeg + Whisper.

### Resume and parallelism

- Finished steps are skipped on a rerun (existing audio, transcript, and finished notes), so after a failure or an interruption just run the same command again.
- A `.video-notes-state.json` file in each video folder records finished videos. If you replace a video file, its entry is invalidated automatically.
- A failure in one video does not stop the batch.
- With several videos, stages overlap: audio extraction (3 at a time), Whisper (1 at a time — it uses the GPU) and the Claude steps (2 at a time). These limits are constants at the top of `process.js`.

## Output

Per video, in the same folder as the video:

- **`<number>-<topic-title>.md`** — the study notes, followed by the original transcript under an "Original Transcript" heading. The leading number comes from the video's file name, which keeps note names unique and in lecture order. The rest comes from the title Claude writes.
- **`<same-name>.docx`** — the notes with screenshots inserted (screenshots enabled only).
- `<name>-frames\` — the kept screenshots plus `frames.json` (timestamps), `captions.json` and `descriptions.json` (local vision-model output).
- `<name>.wav` — extracted audio, only for videos transcribed with Whisper (safe to delete).
- `<name>.segments.json` — timed transcript segments (safe to delete).

## How it works

1. **Transcript** — an `.srt` file if there is one; otherwise ffmpeg extracts 16 kHz mono audio and Whisper transcribes it.
2. **Transcript correction** — for Whisper transcripts only, Claude fixes mis-transcribed technical terms.
3. **Study notes** — Claude generates detailed, self-contained, exam-oriented notes: explanations, definitions, worked examples, an exam-prep section with likely questions and model answers. Diagrams the presenter shows are described in words.
4. **Screenshots** (when `ENABLE_SCREENSHOTS` is on, runs alongside steps 1–3):
   - ffmpeg extracts candidate frames on scene changes, and near-duplicates are removed with SSIM.
   - Claude classifies each remaining frame as useful or discard and writes a short caption.
   - A local vision model (Lemonade, or llama.cpp as a fallback) describes each kept frame and transcribes its on-screen text — see "Local frame analysis" above.
   - Claude inserts one screenshot per time window into the notes, using the descriptions and what the lecturer was saying; pandoc then writes the DOCX.

Screenshots cost extra Claude calls (one per frame, plus one to place them), so they are the largest share of the token use. Set `ENABLE_SCREENSHOTS = false` to skip them.

## Configuration

At the top of `process.js`:

| Constant | Meaning |
|---|---|
| `USE_SUBTITLES` | Use `.srt` files when found (default `true`) |
| `SKIP_FIX_FOR_SUBTITLES` | Skip the Claude transcript-fix call for subtitles (default `true`) |
| `ENABLE_SCREENSHOTS` | Frame extraction, classification, local frame analysis and DOCX (default `true`) |
| `AUDIO_CONCURRENCY`, `WHISPER_CONCURRENCY`, `CLAUDE_CONCURRENCY` | Parallel jobs per stage (the local vision step shares the Whisper limit, since both use the GPU) |
| `CLAUDE_MODEL` | Model used for every Claude CLI call (default `claude-haiku-5-5`) |

The note-generation prompt is `generateNotes()` in `process.js`; edit it to change the structure or style of the notes.

## Troubleshooting

**"No Whisper backend available"** — run `.\setup-whisper.ps1`, or `pip install faster-whisper` into `.venv`.

**"Missing ...whisper-cli.exe"** — the whisper.cpp build is incomplete; rerun `.\setup-whisper.ps1`.

**Setup script says `VULKAN_SDK is not set` / `cmake is not on PATH`** — open a new terminal after the installs so the environment variables refresh, then rerun.

**"Built, but the Vulkan GPU backend was not used"** — whisper.cpp fell back to the CPU; update your GPU drivers.

**"Claude CLI failed"** — check that `claude --version` works and you are logged in. If you hit your usage limit, wait and rerun; finished videos are skipped.

**"ffmpeg failed"** — make sure ffmpeg is on your PATH.
