# Dependency setup plan

Status: phase 1 implemented on `feat/dependency-setup` (branched from `feat/desktop-gui`, PR #2). It also adds `WHISPER_MODEL` / `VISION_MODEL` / `VISION_MMPROJ` settings and **Use** buttons, so a model chosen from the list is actually used. Before this, `transcribe.py` only recognised six hard-coded model names.

## Goal

People who install the Video Notes app should be able to tell, without reading the source:

- which tools the pipeline needs and what each one is for
- whether each tool is set up correctly on their machine
- exactly how to install anything that is missing

Setup stays **optional and user-driven**. The app gives information and checks, but it does not download or install anything by itself.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Auto-install dependencies? | **No, for now.** Show the information and let users run the check themselves. An install engine is listed below as possible future work. | Installing is invasive: admin prompts, PATH changes, downloads of several GB. Informing first keeps the user in control, and the check alone removes most of the guesswork. |
| Whisper model list | Fetched **live from Hugging Face** (`ggerganov/whisper.cpp`), showing name, size and sha256. Information only: each row gives the exact `setup-whisper.ps1 -Model <name>` command. | The list stays current with no hand-maintained catalogue. The sizes help users choose. |
| Vision model list | A **curated list** of 5 repos, with file sizes fetched live. No open-ended Hugging Face search. | Most vision GGUFs from a search would fail with this pipeline (no mmproj file, unsupported architecture, gated, or too large). |
| Branch | `feat/dependency-setup`, from `feat/desktop-gui` | Keeps the GUI pull request small and mergeable. |

## Phase 1: dependency information and a self-check (this branch)

**`deps-check.js`** (repo root, plain Node, shared by the CLI and the GUI) checks each dependency and returns its status, version, path, purpose, when it is needed, and how to install it:

| Dependency | Check | Needed for | How to install (shown to the user) |
|---|---|---|---|
| ffmpeg | `ffmpeg -version` | Audio extraction, screenshots | `winget install Gyan.FFmpeg` or gyan.dev |
| pandoc | `pandoc --version` | DOCX (only with screenshots on) | `winget install JohnMacFarlane.Pandoc` or pandoc.org |
| Claude CLI | `claude --version`; optional login test (one tiny `claude -p` call, user-triggered) | Transcript fix, notes, screenshots | `irm https://claude.ai/install.ps1 \| iex`, then `claude` to log in |
| Python `.venv` | `.venv\Scripts\python.exe --version` | Whisper and vision helpers | `uv sync` or `python -m venv .venv` |
| Whisper backend | `transcribe.py --check` (the same backend and model logic the pipeline uses) | Videos without `.srt` subtitles | `.\setup-whisper.ps1 [-Model <name>]`, or `pip install faster-whisper` |
| Vulkan runtime | `System32\vulkan-1.dll` exists; optional GPU test (whisper-cli on the bundled jfk sample) | GPU transcription | Update the GPU driver |
| Vision model | `frame_analyze.py --check` (Lemonade reachable, or llama-server and model files) | Screenshot descriptions (optional) | Lemonade Server, or `.\setup-llama.ps1` |

How users run it:

- **Terminal:** `npm run check` prints a table. `npm run check -- --deep` adds the GPU test and the Claude login test.
- **App:** a **Dependencies** tab. It has *Check all*, a re-check per row, the two deep tests, a copy button for each install command, and links to each tool's official site. The header badges use the same checks.
- **Before a run:** Start runs the quick check. If something this run needs is missing (based on the screenshot setting and whether the videos have subtitles), a banner names it and offers *Start anyway* or *View dependencies*. It never blocks the run.
- **Models:** a *Whisper models* section lists every `ggml-*.bin` from Hugging Face, with its size and whether it is already downloaded, plus the matching `setup-whisper.ps1 -Model` command. The curated vision models are listed with their live sizes.

## Possible future work (not started)

These come from the earlier review. Pick them up only if the information-only approach is not enough.

1. Per-user data folder (`%LOCALAPPDATA%\VideoNotes`) and bundling the pipeline code in the installer, so no repo clone is needed.
2. An opt-in installer engine: review screen (source, size, licence, target folder) → per-user zip installs of ffmpeg, pandoc and uv/Python → sha256 checked against Hugging Face or the pinned values.
3. Compiling whisper-cli (Vulkan + CPU variants) in CI and bundling it, which removes the 6 GB Visual Studio Build Tools step.
4. Choosing the Whisper and vision models in the app (`WHISPER_MODEL` / `VLM_MODEL` settings), downloading them with progress, and verifying them by sha256.

## Verification for phase 1

- `npm run check` on this machine reports all OK, with versions matching `ffmpeg -version` and so on.
- Hide ffmpeg from PATH: the check reports it missing with the winget command, and Start shows the banner but can still continue.
- `--deep`: the GPU test reports "using Vulkan0 backend". The Claude login test passes, and fails clearly when logged out.
- Offline: the Hugging Face model section shows an error with a link, and the rest of the check still works.
- CI runs `node deps-check.js --json` on the Windows runner. Missing tools there are expected; the step checks only that the output is well formed.
