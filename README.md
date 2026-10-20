# Video → Study Notes Pipeline

A Node.js pipeline that turns lecture videos into self-contained markdown study notes. For each video it gets a transcript (from an existing `.srt` subtitle file, or by transcribing the audio locally with Whisper) and sends it to an LLM to generate exam-oriented notes. The LLM is the Claude CLI by default; the Anthropic API, OpenAI or another OpenAI-compatible service, or an open model running locally in Ollama, LM Studio or Lemonade also work (see [Choosing the LLM](#choosing-the-llm)). With screenshots enabled (the default) it also picks the useful lecture frames, describes them with a local vision model, and produces a DOCX with the screenshots placed in the notes.

## Prerequisites

- **Node.js** (v16+)
- **ffmpeg** on PATH (audio extraction, and frame extraction for screenshots)
- **pandoc** on PATH (DOCX output when screenshots are enabled)
- **An LLM:** the Claude Code CLI (`claude`) installed and logged in (the default), or one of the other providers in [Choosing the LLM](#choosing-the-llm)
- **A Whisper backend** (only needed for videos without subtitles) — see below
- **Python 3** — `transcribe.py` is launched through `.venv\Scripts\python.exe`

```bash
python -m venv .venv
```

### Checking your setup

The app doesn't install anything. To see what's missing and how to install it, run:

```bash
npm run check              # every dependency: found or missing, version, how to install it
npm run check -- --deep    # also: Whisper GPU test, and one short prompt to the configured LLM
npm run check -- --models  # also: Whisper and vision models available on Hugging Face, with sizes
```

The desktop app's **Dependencies** tab shows the same information. For each tool it shows the install commands with Copy buttons and links to the official download pages. It also has an **Open PowerShell here** button that opens a terminal in the pipeline folder, plus the same two deep tests. When you press **Start**, the app checks what that particular run needs (for example, Whisper only for videos without subtitles). If something is missing it tells you, but you can still start anyway.

## Choosing the LLM

One LLM does the transcript fix, the notes, the frame classification and the screenshot placement. Pick it in the app under **Settings → LLM provider**, or set `LLM_PROVIDER` in `settings.json`:

| Provider (`LLM_PROVIDER`) | What it is | Needs |
|---|---|---|
| `claude-cli` (default) | Claude through the logged-in `claude` command, on your Claude subscription | `claude` installed and logged in |
| `anthropic` | Claude through the Anthropic API, using the official SDK (billed per token) | An API key; `npm install` for the SDK |
| `openai` | OpenAI's API | An API key |
| `openrouter` | Many hosted models through one OpenAI-compatible API | An API key |
| `ollama` | Open models running locally in [Ollama](https://ollama.com) | Ollama running and a model pulled (`ollama pull <model>`) |
| `lmstudio` | Open models running locally in [LM Studio](https://lmstudio.ai) | LM Studio's server running with a model loaded (`lms server start`); its API token if authentication is on |
| `lemonade` | Open models running locally in [Lemonade Server](https://lemonade-server.ai) | Lemonade running with a model loaded |
| `custom` | Any other server with an OpenAI-style `/chat/completions` endpoint (vLLM, llama.cpp's server, LocalAI...) | Its base URL, and a key if it requires one |

How each provider is set up:
- **Claude providers** use `CLAUDE_MODEL`.
- **The others** use these settings:
  - `LLM_MODEL` for the model.
  - `LLM_BASE_URL` to override the preset's address.
  - `LLM_VISION_MODEL` for an image-capable model used to classify screenshots. If it's empty, `LLM_MODEL` is used, so set it when your main model can't read images. With screenshots off, nothing image-related is sent.
- **Model list:** in the app, **Load models** asks the server what it has.
- **Checking the setup:** `npm run check` confirms the server answers and lists the configured models; `npm run check -- --deep` sends one short prompt.

**API keys** come from environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `LM_API_TOKEN`, `LEMONADE_API_KEY`, `OLLAMA_API_KEY` or `LLM_API_KEY` (custom). In the app you can paste a key under **Settings → LLM provider** instead:
- It is encrypted for your Windows user (DPAPI), stored outside `settings.json`, and passed to the pipeline as that variable.
- It is never written to the repo.

**Local models, what to expect:**
- **Quality and speed:** both depend on the model. Notes are long and detailed, so small models (under ~8B parameters) tend to produce thin notes or ignore the requested format. Frame classification needs a vision model; open models with "VL" or "vision" in the name.
- **Context window:** a one-hour lecture transcript is about 12k tokens, and the notes need room on top.
  - **Ollama:** the pipeline sets the context window to `LLM_CONTEXT_TOKENS` (default 32768) and warns if a prompt looks too big for it.
  - **LM Studio:** set the context length when loading the model (`lms load <model> --context-length 32768`).
- **Concurrency:** a local server works through requests one by one, so set `CLAUDE_CONCURRENCY` and `FRAME_CLASSIFY_CONCURRENCY` to 1–2.
- **GPU sharing:** the model shares the GPU with Whisper and the vision step. With `LOCAL_LLM_GPU_LOCK` on (the default), they take turns so they don't run out of GPU memory together. Turn it off if your GPU has memory for all of them.
- **Long replies:** replies are streamed, and each request may take up to `LLM_TIMEOUT_MINUTES` (default 30).
- **Cleanup:** reasoning (`<think>...</think>`) and a code fence wrapped around the whole reply are removed automatically.

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

With screenshots enabled, kept frames are also described by a local vision model via `frame_analyze.py`. It writes `descriptions.json` (a description plus on-screen text per frame) into the `-frames` folder, and the image-placement prompt uses it. The LLM still classifies and captions the frames.

**Preferred: Lemonade Server** (AMD, good fit for Ryzen AI). Install it, start it, and pull a vision model: `lemonade pull Qwen3-VL-8B-Instruct-GGUF`. The script uses it automatically when it answers at `LEMONADE_URL` (default `http://localhost:13305/api/v1`). Pick another model with `LEMONADE_MODEL`.

**Fallback: llama.cpp.** If Lemonade isn't running, the script launches `llama-server` itself (Qwen2.5-VL-3B, Vulkan GPU). Run `.\setup-whisper.ps1` first (it installs the build tools), then `.\setup-llama.ps1`. Override with `VLM_MODEL` / `VLM_MMPROJ` (paths) or `LLAMA_SERVER`.

If neither is available, the stage logs a warning and the pipeline carries on with the LLM's captions. You can also run it by hand on a frames folder, a video, or a folder of videos: `python frame_analyze.py <path>`.

### How frames are selected and described

1. **Candidates.** ffmpeg keeps a frame whenever the scene-change score exceeds `SCENE_CHANGE_THRESHOLD` (0.02). That is low on purpose: slide and screen-capture lectures change by text appearing, not by cuts, so movie-style thresholds barely fire. Each frame's timestamp is saved to `frames.json`.
2. **Deduplication.** `dedupeFrames` compares each frame with the previous kept one using ffmpeg's SSIM and drops it at or above `SSIM_DUPLICATE_THRESHOLD` (0.9). Pen or cursor movement on the same slide scores about 0.84–0.96, so this removes most repeats. Lower the threshold to keep fewer frames, raise it to keep more build-up steps.
3. **Classification.** The LLM marks each remaining frame `USEFUL` or `DISCARD` (blank frames, transitions, a talking head with no visual) and writes a short caption. Discarded frames are deleted.
4. **Local description.** `frame_analyze.py` sends each kept frame to a local vision model and stores a description plus the on-screen text in `descriptions.json`. This gives the placement step much better context than a 15-word caption, and it costs no LLM tokens.
5. **Placement.** The lecture is split into time windows, each window contributes its last kept frame (the most complete version of a diagram that builds up), and the LLM inserts each one where the lecturer was talking about it.

**Model choice (Lemonade).** The default is `Qwen3-VL-8B-Instruct-GGUF`, run by Lemonade Server on the GPU (tested on a Radeon 8060S). On a 4-frame test it took about 4 s per frame once loaded, and it read slide text more completely than Qwen2.5-VL-3B. The 4B model was no faster in testing (about 3.2 s per frame against 4 s) and its descriptions were vaguer. Sending 4 frames as a 2×2 grid, or sending requests in parallel, gave no speedup locally. Change the model with `LEMONADE_MODEL`.

## Usage

### Desktop app

```bash
npm install     # once: installs Electron and electron-builder
npm run gui     # opens the Video Notes window
```

Pick a video or folder (or drag one onto the window) and press **Start**. The window shows:

- **Stage board**: one row per video with a chip for each stage (srt, audio, whisper, frames, filter, vision, fix, notes, docx). The chips go dashed while a stage waits for a slot (for example "waiting for GPU"), blue while it runs, green when done, red when it fails, and struck through when skipped. The status column shows live progress such as `whisper 35%`, `filter 12/40` and `vision 3/18`. Buttons open the notes, the DOCX and the frames folder. **Reset** clears a finished video's entry in `.video-notes-state.json` so the next run processes it again.
- **Log monitor**: every pipeline line, tagged with its video. It includes the live output of whisper.cpp and the vision model (the `debug` level). You can filter by video, level or text. Each run is also written to `logs\run-<time>.log`.
- **Stop**: kills the run and every process it started (ffmpeg, Python, whisper-cli, claude). Finished steps are kept, so pressing Start again resumes.
- **Settings tab**: edits the settings listed under [Configuration](#configuration) and saves them to `settings.json`, which `node process.js` reads too.
- **Pre-flight badges**: show whether `ffmpeg`, `pandoc`, `claude` and `.venv` were found.

#### Installer and portable exe

```bash
npm run dist              # both, into dist\
npm run dist:installer    # dist\VideoNotes-Setup-<version>.exe
npm run dist:portable     # dist\VideoNotes-Portable-<version>.exe
```

The app contains only the GUI. The pipeline still runs from this folder, using `process.js`, the Python helpers, `.venv` and `tools\`. That keeps the exe small and lets pipeline edits take effect without a rebuild. On first launch, an installed app asks for this folder ("Pipeline folder") and remembers your choice. A portable exe placed in this folder finds it automatically. The prerequisites above are still needed, and the builds are unsigned, so Windows SmartScreen will warn on first run.

#### CI/CD

`.github/workflows/ci.yml` runs on GitHub-hosted Windows runners for pushes to `main` and `feat/**`, and for pull requests:

- **Check**: syntax checks, plus a smoke test that forks `process.js` the way the app does.
- **Build**: the installer and portable exe, downloadable from the run's artifacts.

Pushing a tag such as `v1.1.0` also publishes both exes as a GitHub release, versioned from the tag.

### Command line

```bash
node process.js path\to\video.mp4          # one video
node process.js C:\path\to\Videos          # a folder, including all subfolders
```

Supported formats: `.mp4`, `.mkv`, `.avi`, `.mov`, `.flv`, `.webm`, `.m4v`, `.ts`, `.mts`, `.m2ts` (add others with the `VIDEO_EXTS` env var, e.g. `VIDEO_EXTS=.vob,.3gp`)

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
- With several videos, stages overlap: audio extraction (3 at a time), Whisper (1 at a time — it uses the GPU) and the LLM steps (4 at a time). These limits are settings (see [Configuration](#configuration)).

## Output

Per video, in the same folder as the video:

- **`<number>-<topic-title>.md`** — the study notes, followed by the original transcript under an "Original Transcript" heading. The leading number is zero-padded (`02-`, `10-`) and comes from the video's file name, or from the video's position in its folder if the name has no number; the `.docx` uses the same name. This keeps note names unique and in lecture order. The rest comes from the title the LLM writes.
- **`<same-name>.docx`** — the notes with screenshots inserted (screenshots enabled only).
- `<name>-frames\` — the kept screenshots plus `frames.json` (timestamps), `captions.json` and `descriptions.json` (local vision-model output).
- `<name>.wav` — extracted audio, only for videos transcribed with Whisper (safe to delete).
- `<name>.segments.json` — timed transcript segments (safe to delete).

## How it works

1. **Transcript** — an `.srt` file if there is one; otherwise ffmpeg extracts 16 kHz mono audio and Whisper transcribes it.
2. **Transcript correction** — for Whisper transcripts only, the LLM fixes mis-transcribed technical terms.
3. **Study notes** — the LLM generates detailed, self-contained, exam-oriented notes: explanations, definitions, worked examples, an exam-prep section with likely questions and model answers. Diagrams the presenter shows are described in words.
4. **Screenshots** (when `ENABLE_SCREENSHOTS` is on, runs alongside steps 1–3):
   - ffmpeg extracts candidate frames on scene changes, and near-duplicates are removed with SSIM.
   - The LLM classifies each remaining frame as useful or discard and writes a short caption.
   - A local vision model (Lemonade, or llama.cpp as a fallback) describes each kept frame and transcribes its on-screen text — see "Local frame analysis" above.
   - The LLM inserts one screenshot per time window into the notes, using the descriptions and what the lecturer was saying; pandoc then writes the DOCX.

Screenshots cost extra LLM calls (one per frame, plus one to place them), so they are the largest share of the token use. Turn off `ENABLE_SCREENSHOTS` to skip them.

## Configuration

Defaults are in `DEFAULT_SETTINGS` at the top of `process.js`. To override any of them, edit `settings.json` in this folder; the app's Settings tab writes the same file. For example:

```json
{ "ENABLE_SCREENSHOTS": false, "CLAUDE_CONCURRENCY": 2 }
```

| Setting | Meaning |
|---|---|
| `USE_SUBTITLES` | Use `.srt` files when found (default `true`) |
| `SKIP_FIX_FOR_SUBTITLES` | Skip the LLM transcript-fix call for subtitles (default `true`) |
| `ENABLE_SCREENSHOTS` | Frame extraction, classification, local frame analysis and DOCX (default `true`) |
| `AUDIO_CONCURRENCY`, `WHISPER_CONCURRENCY`, `CLAUDE_CONCURRENCY` | Parallel jobs per stage (the local vision step shares the Whisper limit, since both use the GPU) |
| `FRAME_CLASSIFY_CONCURRENCY` | Frames classified by the LLM at once, per video (default `4`; 1–2 for a local model) |
| `SCENE_CHANGE_THRESHOLD`, `SSIM_DUPLICATE_THRESHOLD` | Candidate-frame scene threshold and duplicate cut-off (defaults `0.02`, `0.9`) |
| `PLACEMENT_WINDOW_SECONDS` | One screenshot per window of this length (default `30`) |
| `LLM_PROVIDER` | Which LLM does the text and image prompts (default `claude-cli`; see [Choosing the LLM](#choosing-the-llm)) |
| `CLAUDE_MODEL` | Claude model for the `claude-cli` and `anthropic` providers (default `claude-haiku-5-5`) |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_VISION_MODEL` | Server address (empty = the preset's), model, and image-capable model for the other providers |
| `LLM_CONTEXT_TOKENS`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_TIMEOUT_MINUTES` | Ollama context window (default `32768`), output cap (`0` = server default; 64000 for the Anthropic API), per-request time limit (default `30`) |
| `LOCAL_LLM_GPU_LOCK` | A local LLM takes turns on the GPU with Whisper and the vision step (default `true`) |
| `WHISPER_MODEL` | Whisper model file in `tools\whisper.cpp\models` (e.g. `ggml-large-v3-turbo-q5_0.bin`). Empty = the most accurate one downloaded |
| `VISION_MODEL`, `VISION_MMPROJ` | llama.cpp vision model and mmproj files in `tools\models`. Empty = the Qwen2.5-VL-3B files from `setup-llama.ps1` |

Download other Whisper models with `.\setup-whisper.ps1 -Model <name>`, using any name from `npm run check -- --models` (for example `large-v3-turbo-q5_0`). In the app, **Dependencies → Models** lists them with their sizes, and a **Use** button appears once a model is downloaded.

The note-generation prompt is `generateNotes()` in `process.js`; edit it to change the structure or style of the notes.

## Troubleshooting

**"No Whisper backend available"** — run `.\setup-whisper.ps1`, or `pip install faster-whisper` into `.venv`.

**"Missing ...whisper-cli.exe"** — the whisper.cpp build is incomplete; rerun `.\setup-whisper.ps1`.

**Setup script says `VULKAN_SDK is not set` / `cmake is not on PATH`** — open a new terminal after the installs so the environment variables refresh, then rerun.

**"Built, but the Vulkan GPU backend was not used"** — whisper.cpp fell back to the CPU; update your GPU drivers.

**"Claude failed" / "LM Studio failed" / ...** — run `npm run check -- --deep`: it names what's wrong (not logged in, no key, server not running, model not found). For the Claude CLI, check that `claude --version` works and you are logged in. If you hit your usage limit, wait and rerun; finished videos are skipped.

**"ffmpeg failed"** — make sure ffmpeg is on your PATH.
