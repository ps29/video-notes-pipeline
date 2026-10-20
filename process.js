const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const os = require('os');
const crypto = require('crypto');
const execAsync = promisify(exec);

const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 };

// Defaults for every tunable. settings.json next to this file (written by the GUI's
// Settings tab, or by hand) overrides any of them.
const DEFAULT_SETTINGS = {
  // Screenshot stages (frame extraction, Claude frame classification, local-model frame
  // analysis, image placement, DOCX). They cost extra CLI calls; set to false to skip them.
  ENABLE_SCREENSHOTS: true,

  // Claude model used for every CLI call in the pipeline.
  CLAUDE_MODEL: 'claude-haiku-5-5',

  // If a video already has an .srt subtitle file, use it as the transcript instead of
  // running Whisper (faster, and human captions are usually more accurate on technical
  // terms). Looked up as <videoFolder>_subtitles/<name>.srt, then <videoFolder>/<name>.srt.
  USE_SUBTITLES: true,

  // Subtitles are already clean, so the Claude transcript-fix call is skipped for them.
  SKIP_FIX_FOR_SUBTITLES: true,

  // Max concurrent jobs per stage when several videos are queued (folder mode).
  // Whisper runs on the single GPU, so it stays at 1; ffmpeg is cheap CPU work;
  // the Claude CLI steps are network-bound but share your subscription's usage limits.
  AUDIO_CONCURRENCY: 3,
  WHISPER_CONCURRENCY: 1,
  CLAUDE_CONCURRENCY: 4,

  // How many frames to classify with Claude at once. Keeps a lecture video's
  // worth of frames from fully serializing while staying under API rate limits.
  FRAME_CLASSIFY_CONCURRENCY: 4,

  // Scene-change threshold: higher = fewer, more distinct candidate frames.
  // Screen-capture lecture recordings (slides/code, mostly static camera) have
  // much lower scene-score variance than real camera footage: 0.02 is tuned for
  // that case. Raise it if too many near-duplicate frames come through.
  SCENE_CHANGE_THRESHOLD: 0.02,

  // SSIM above this between a kept frame and the last kept frame means the same
  // slide/diagram is on screen (pen or hand movement only), so the frame is dropped.
  // Measured on a lecture video: same-slide neighbours scored ~0.84-0.96.
  SSIM_DUPLICATE_THRESHOLD: 0.9,

  // Screenshots are chosen by lecture time: the timeline is split into windows and
  // each window contributes its last useful frame.
  PLACEMENT_WINDOW_SECONDS: 30,
};

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const settings = loadSettings();
const {
  ENABLE_SCREENSHOTS, CLAUDE_MODEL, USE_SUBTITLES, SKIP_FIX_FOR_SUBTITLES,
  AUDIO_CONCURRENCY, WHISPER_CONCURRENCY, CLAUDE_CONCURRENCY, FRAME_CLASSIFY_CONCURRENCY,
  SCENE_CHANGE_THRESHOLD, SSIM_DUPLICATE_THRESHOLD, PLACEMENT_WINDOW_SECONDS,
} = settings;

// When forked by the GUI (gui/main.js), log lines and stage changes go to the parent
// over IPC as structured messages; under the CLI they print as plain console lines.
const WORKER_MODE = typeof process.send === 'function' && process.env.VIDEO_NOTES_WORKER === '1';

// Tracks which video the current async call chain belongs to, so concurrent videos'
// log lines can be told apart without passing the video through every function.
const videoContext = new AsyncLocalStorage();

function send(msg) {
  if (WORKER_MODE) process.send({ ...msg, video: msg.video ?? videoContext.getStore() ?? null, ts: Date.now() });
}

function logLine(level, args) {
  const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
  if (WORKER_MODE) return send({ type: 'log', level, msg });
  if (level === 'debug') return; // subprocess chatter is only shown in the GUI
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(msg);
}

const log = {
  info: (...a) => logLine('info', a),
  warn: (...a) => logLine('warn', a),
  error: (...a) => logLine('error', a),
  debug: (...a) => logLine('debug', a),
};

// Stage status for the GUI board: waiting | running | done | skipped | failed.
function emitStage(stage, status, info) {
  send({ type: 'stage', stage, status, info });
}

// Runs fn as `stage`, reporting running/done/failed around it.
async function track(stage, fn) {
  emitStage(stage, 'running');
  try {
    const result = await fn();
    emitStage(stage, 'done');
    return result;
  } catch (err) {
    emitStage(stage, 'failed');
    throw err;
  }
}

// Queues fn on a limiter as `stage`: "waiting" until a slot frees up, then tracked.
function inLimit(limit, stage, fn) {
  emitStage(stage, 'waiting');
  return limit(() => track(stage, fn));
}

// Like execAsync, but streams stderr lines to the debug log while the command runs.
// Resolves with { stdout, stderr }; rejects with an Error carrying .stderr on non-zero exit.
function spawnStreaming(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...opts });
    let stdout = '', stderr = '', pending = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => {
      stderr += d;
      const lines = (pending + d).split(/\r?\n|\r/);
      pending = lines.pop();
      lines.filter(l => l.trim()).forEach(l => log.debug(l));
    });
    child.on('error', reject);
    child.on('close', code => {
      if (pending.trim()) log.debug(pending);
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${path.basename(command)} exited with code ${code}: ${stderr.trim().split('\n').pop() || ''}`);
      err.stderr = stderr;
      reject(err);
    });
  });
}

// Extensions picked up when scanning a folder. Add more via the VIDEO_EXTS env var,
// e.g. VIDEO_EXTS=.vob,.3gp (comma-separated, leading dot optional).
const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.m4v', '.ts', '.mts', '.m2ts',
  ...(process.env.VIDEO_EXTS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    .map(e => (e.startsWith('.') ? e : `.${e}`)),
];

// Runs the claude CLI with a prompt, passed via a temp file + stdin redirect
// (async child_process.exec doesn't support the `input` option execSync has).
// `images` is an array of PNG file paths; the CLI reads them with its Read tool.
async function runClaude(prompt, { images = [] } = {}) {
  let extraArgs = '';
  if (images.length > 0) {
    const dirs = [...new Set(images.map(p => path.dirname(p)))];
    extraArgs = `${dirs.map(d => `--add-dir "${d}"`).join(' ')} --allowedTools Read`;
    prompt = `Look at the image${images.length > 1 ? 's' : ''} at ${images.length > 1 ? 'these paths' : 'this path'}: ${images.join(', ')}\n\n${prompt}`;
  }
  const tmpFile = path.join(os.tmpdir(), `claude-prompt-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf-8');
  try {
    const { stdout } = await execAsync(`claude -p --model ${CLAUDE_MODEL} ${extraArgs} < "${tmpFile}"`, EXEC_OPTS);
    return stdout.trim();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  // AsyncResource.bind keeps the job in its caller's video context: it otherwise runs
  // inside whichever job's `finally` freed the slot.
  return fn => new Promise((resolve, reject) => { queue.push({ fn: AsyncResource.bind(fn), resolve, reject }); next(); });
}

// Write to a temp name and rename, so a crash never leaves a half-written file
// that a later run would mistake for a finished step.
function writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

// Per-folder record of finished videos, so a rerun skips them entirely.
// Keyed by file name; the video's size and mtime invalidate the entry if it changes.
function stateFile(videoPath) {
  return path.join(path.dirname(videoPath), '.video-notes-state.json');
}

function videoFingerprint(videoPath) {
  const { size, mtimeMs } = fs.statSync(videoPath);
  return `${size}:${Math.floor(mtimeMs)}`;
}

function getFinishedNotes(videoPath) {
  try {
    const entry = JSON.parse(fs.readFileSync(stateFile(videoPath), 'utf-8'))[path.basename(videoPath)];
    if (entry && entry.fingerprint === videoFingerprint(videoPath) && fs.existsSync(entry.notesPath)) {
      return entry.notesPath;
    }
  } catch { /* no state yet */ }
  return null;
}

function markFinished(videoPath, notesPath) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile(videoPath), 'utf-8')); } catch { /* new state file */ }
  state[path.basename(videoPath)] = { fingerprint: videoFingerprint(videoPath), notesPath };
  writeFileAtomic(stateFile(videoPath), JSON.stringify(state, null, 2));
}

function findSubtitle(videoPath) {
  const dir = path.dirname(videoPath);
  const baseName = path.basename(videoPath, path.extname(videoPath));
  return [path.join(`${dir}_subtitles`, `${baseName}.srt`), path.join(dir, `${baseName}.srt`)]
    .find(p => fs.existsSync(p)) || null;
}

function srtTimeToSeconds(t) {
  const [h, m, rest] = t.trim().split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
}

// Parses an SRT file into the same outputs transcribe() produces: <name>.raw.txt
// (plain text) and <name>.segments.json ({start, end, text} per cue).
function loadSubtitleTranscript(videoPath, srtPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const outputDir = path.dirname(videoPath);
  const transcriptPath = path.join(outputDir, `${baseName}.raw.txt`);

  const segments = fs.readFileSync(srtPath, 'utf-8')
    .replace(/^﻿/, '')
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(Boolean))
    .map(lines => {
      const timingIdx = lines.findIndex(l => l.includes('-->'));
      if (timingIdx === -1) return null;
      const [start, end] = lines[timingIdx].split('-->');
      const text = lines.slice(timingIdx + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      return text ? { start: srtTimeToSeconds(start), end: srtTimeToSeconds(end), text } : null;
    })
    .filter(Boolean);

  if (segments.length === 0) throw new Error(`No subtitle text found in ${srtPath}`);

  log.info(`✓ Using subtitles instead of Whisper: ${srtPath}`);
  writeFileAtomic(path.join(outputDir, `${baseName}.segments.json`), JSON.stringify(segments, null, 2));
  writeFileAtomic(transcriptPath, segments.map(s => s.text).join(' '));
  return transcriptPath;
}

// ffmpeg's error output starts with its full build banner; the cause is the last line.
function ffmpegError(err) {
  return (err.stderr || err.message).toString().trim().split(/\r?\n/).pop();
}

async function extractAudio(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const audioPath = path.join(path.dirname(videoPath), `${baseName}.wav`);

  if (fs.existsSync(audioPath)) {
    log.info(`✓ Audio already extracted, skipping: ${audioPath}`);
    return audioPath;
  }

  log.info(`[audio] Extracting audio from ${videoPath}...`);
  const tmpPath = path.join(path.dirname(videoPath), `${baseName}.tmp.wav`);
  try {
    await execAsync(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -y "${tmpPath}"`, EXEC_OPTS);
    fs.renameSync(tmpPath, audioPath);
    log.info(`✓ Audio extracted: ${audioPath}`);
    return audioPath;
  } catch (err) {
    throw new Error(`ffmpeg failed: ${ffmpegError(err)}`);
  }
}

async function extractFrames(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const framesDir = path.join(path.dirname(videoPath), `${baseName}-frames`);

  log.info(`[frames] Extracting candidate frames from ${videoPath}...`);
  fs.mkdirSync(framesDir, { recursive: true });
  try {
    const { stderr } = await execAsync(
      `ffmpeg -i "${videoPath}" -vf "select='gt(scene,${SCENE_CHANGE_THRESHOLD})',showinfo" -vsync vfr "${path.join(framesDir, 'candidate_%04d.png')}"`,
      EXEC_OPTS
    );

    // showinfo prints one pts_time per output frame, in file order. Save them so
    // each frame can later be matched to what the lecturer was saying at that moment.
    const times = [...stderr.matchAll(/Parsed_showinfo.*? pts_time:([0-9.]+)/g)].map(m => parseFloat(m[1]));
    const frameTimes = {};
    times.forEach((t, i) => { frameTimes[`candidate_${String(i + 1).padStart(4, '0')}.png`] = t; });
    fs.writeFileSync(path.join(framesDir, 'frames.json'), JSON.stringify(frameTimes, null, 2), 'utf-8');

    const frameCount = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).length;
    log.info(`✓ Extracted ${frameCount} candidate frame(s): ${framesDir}`);
    return framesDir;
  } catch (err) {
    throw new Error(`ffmpeg frame extraction failed: ${ffmpegError(err)}`);
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function filterFrames(framesDir) {
  const allFrames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();

  // Drop near-duplicates before paying for a Claude call on each frame.
  const frames = await dedupeFrames(framesDir, allFrames);

  log.info(`[filter] Classifying ${frames.length} unique candidate frame(s) with Claude (${FRAME_CLASSIFY_CONCURRENCY} at a time)...`);

  let classified = 0;
  const keptFlags = await mapWithConcurrency(frames, FRAME_CLASSIFY_CONCURRENCY, async (frameFile) => {
    const verdict = await classifyFrame(frameFile);
    classified++;
    emitStage('filter', 'running', { done: classified, total: frames.length });
    if (classified % 10 === 0 || classified === frames.length) {
      log.info(`[filter] ${path.basename(framesDir)}: ${progressBar(classified, frames.length)} frames classified`);
    }
    return verdict;
  });

  async function classifyFrame(frameFile) {
    const framePath = path.join(framesDir, frameFile);
    const prompt = `This image is a frame extracted from a computer science lecture video. Decide whether it is worth keeping as a reference screenshot in study notes.

Respond in exactly this format, and nothing else:
Line 1: USEFUL or DISCARD
Line 2: if USEFUL, a short caption (under 15 words) describing what the frame shows; otherwise leave it empty.
- USEFUL: the frame shows a diagram, code snippet, chart, equation, slide text, or other reference-worthy visual content.
- DISCARD: the frame is blank, a blurry transition, or just shows a presenter/talking head with no supporting visual.`;

    try {
      const output = await runClaude(prompt, { images: [framePath] });
      const [verdict, ...rest] = output.split('\n');
      const useful = /^USEFUL/i.test(verdict.trim());
      return { useful, caption: rest.join(' ').trim() };
    } catch (err) {
      log.error(`Frame classification failed for ${frameFile}:`, err.message);
      return { useful: false, caption: '' };
    }
  }

  frames.forEach((frameFile, i) => {
    if (!keptFlags[i].useful) fs.unlinkSync(path.join(framesDir, frameFile));
  });

  const keptFrames = frames.filter((_, i) => keptFlags[i].useful);

  // Captions are saved next to the frames so the notes step can match each
  // image to the section it illustrates. Only frames that survived dedupe are kept.
  const captions = {};
  for (const frameFile of keptFrames) {
    if (fs.existsSync(path.join(framesDir, frameFile))) {
      captions[frameFile] = keptFlags[frames.indexOf(frameFile)].caption;
    }
  }
  fs.writeFileSync(path.join(framesDir, 'captions.json'), JSON.stringify(captions, null, 2), 'utf-8');

  log.info(`✓ Kept ${keptFrames.length}/${frames.length} useful frame(s) after removing duplicates: ${framesDir}`);
  return framesDir;
}

// Describes the kept frames (and transcribes their on-screen text) with a local vision model
// via frame_analyze.py. Optional: on any failure the pipeline continues with Claude's captions.
async function analyzeFrames(framesDir) {
  log.info(`[analyze] Describing kept frames with the local vision model...`);
  try {
    const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    await spawnStreaming(venvPython, [path.join(__dirname, 'frame_analyze.py'), framesDir]);
    log.info(`✓ Frame descriptions saved: ${path.join(framesDir, 'descriptions.json')}`);
  } catch (err) {
    log.warn(`Local frame analysis skipped (run setup-llama.ps1?): ${(err.stderr || err.message).toString().trim().split('\n').pop()}`);
  }
  return framesDir;
}

async function ssimBetween(fileA, fileB) {
  const { stdout } = await execAsync(
    `ffmpeg -hide_banner -i "${fileA}" -i "${fileB}" -lavfi ssim -f null - 2>&1`,
    EXEC_OPTS
  );
  const match = stdout.match(/All:([0-9.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

// Deletes frames that duplicate the previously kept frame. Returns the file names that remain.
async function dedupeFrames(framesDir, frameFiles) {
  let lastKept = null;
  const remaining = [];
  for (const frameFile of frameFiles) {
    const framePath = path.join(framesDir, frameFile);
    if (lastKept && await ssimBetween(lastKept, framePath) >= SSIM_DUPLICATE_THRESHOLD) {
      fs.unlinkSync(framePath);
    } else {
      lastKept = framePath;
      remaining.push(frameFile);
    }
  }
  return remaining;
}

async function transcribe(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outputDir = path.dirname(audioPath);
  const transcriptPath = path.join(outputDir, `${baseName}.raw.txt`);

  if (fs.existsSync(transcriptPath) && fs.statSync(transcriptPath).size > 0) {
    log.info(`✓ Raw transcript already exists, skipping: ${transcriptPath}`);
    return transcriptPath;
  }

  log.info(`[transcribe] Transcribing ${path.basename(audioPath)} with whisper.cpp (GPU)...`);
  try {
    const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    const { stdout } = await spawnStreaming(venvPython, [path.join(__dirname, 'transcribe.py'), audioPath]);
    writeFileAtomic(transcriptPath, stdout.trim());
    log.info(`✓ Raw transcript saved: ${transcriptPath}`);
    return transcriptPath;
  } catch (err) {
    throw new Error(`Transcription failed: ${err.message}`);
  }
}

async function fixTranscript(transcriptPath) {
  const rawText = fs.readFileSync(transcriptPath, 'utf-8');
  const baseName = path.basename(transcriptPath, path.extname(transcriptPath));
  const outputDir = path.dirname(transcriptPath);
  const fixedPath = path.join(outputDir, `${baseName}.fixed.md`);

  if (fs.existsSync(fixedPath) && fs.statSync(fixedPath).size > 0) {
    log.info(`✓ Fixed transcript already exists, skipping: ${fixedPath}`);
    return fixedPath;
  }

  log.info(`[fix] Fixing transcript with Claude...`);
  const prompt = `You are correcting a speech-to-text transcript of a computer science lecture or educational video. Fix mis-transcribed technical terms, names, programming concepts, and phrases using context. Preserve the original meaning and structure. Output only the corrected transcript, nothing else.

Transcript to fix:
${rawText}`;

  try {
    const output = await runClaude(prompt);
    if (!output) throw new Error('empty response');
    writeFileAtomic(fixedPath, output);
    log.info(`✓ Fixed transcript saved: ${fixedPath}`);
    return fixedPath;
  } catch (err) {
    throw new Error(`Claude CLI failed (transcript fix): ${err.message}`);
  }
}

// Zero-padded reading-order number for a video's output files: the video's own leading
// number if it has one, otherwise its position in the folder.
function sequencePrefix(videoPath, { position = 1, width = 2 } = {}) {
  const m = path.basename(videoPath).match(/^(\d+)/);
  return String(m ? parseInt(m[1], 10) : position).padStart(width, '0');
}

async function generateNotes(fixedTranscriptPath, prefix = '01') {
  const fixedText = fs.readFileSync(fixedTranscriptPath, 'utf-8');
  const baseName = path.basename(fixedTranscriptPath, path.extname(fixedTranscriptPath)).replace('.raw', '');
  const outputDir = path.dirname(fixedTranscriptPath);

  log.info(`[notes] Generating study notes with Claude...`);
  const prompt = `This is a non-interactive, one-shot generation — you cannot ask clarifying questions or present options. If you're torn between two approaches (e.g., how deep to go on a topic), always choose the more thorough, more explanatory one. When supplementing with outside knowledge beyond what the video said, label it clearly (e.g., under "Additional context" or inline as "(not covered in the video:)") so the reader can tell what's the video's framing vs. your addition. Further the goal is to create detailed, self-contained markdown study notes from this computer science video transcript. The reader should be able to fully understand and learn the material WITHOUT watching the video — treat this as writing the explanation the video should have given, not just summarizing what was said.

Start with:

# [Topic Title]

Then a 2-4 sentence **TL;DR** of what this video covers and why it matters.

Then, organized by topic/section covered in the video:
- **Explain each concept properly**, not just note that it was mentioned. If the presenter's explanation is thin, rushed, or assumes background knowledge, fill the gap yourself with a clear explanation, definition, or analogy so nothing is confusing.
- Key terms and definitions in bold, with your own clarifying explanation alongside the video's (reference roughly where in the video it came up if there's a timestamp or clear ordering cue)
- Code examples or pseudocode from the video, reproduced and commented/explained line by line if not already clear
- Where useful, add **"Additional context"** callouts with supplementary material not in the video: related concepts, common pitfalls, how this connects to other CS topics, or a better example than the one given — anything that deepens understanding
- Bullet points for important details, caveats, and edge cases the presenter mentioned
- Reference the video as the source for what it actually covers (e.g., "The video explains...", "According to the presenter...") but don't limit the notes to only what was said if more explanation would help

- No screenshots or images will accompany these notes. When the presenter draws or shows a diagram, table, or visual (e.g. "as you can see here"), describe it fully in words, or recreate it as a markdown table, ASCII diagram, or code block, so nothing depends on seeing the video.
- Every definition, formula, algorithm, rule, and worked example the lesson covers must appear in the notes in full, so a student can prepare for an exam from these notes alone, without the video or the transcript.

End with:
- A **Key Takeaways** section (bullet list of the most important points)
- An **Exam Prep** section: a quick-review list of must-know definitions and formulas, plus 5-10 likely exam questions (short-answer and problem-style) with concise model answers
- If relevant, a short **Things to study further** section

Favor depth and clarity over brevity. The goal is for someone to read these notes and come away with a better understanding than if they'd watched the video passively.

Transcript from video:
${fixedText}`;

  try {
    const notesOutput = await runClaude(prompt);
    if (!notesOutput) throw new Error('empty response');

    // Extract title from the markdown (first # heading)
    const titleMatch = notesOutput.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Study Notes';

    // Convert title to filename: lowercase, replace spaces with hyphens, remove special chars.
    // Titles are written by Claude and often generic ("Study Notes") or repeated across
    // videos, so a zero-padded sequence number is prefixed to keep every name unique
    // (and the files in reading order).
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 60);
    const filename = `${prefix}-${slug}.md`;

    const finalPath = path.join(outputDir, filename);

    // Create combined markdown: transcript + notes
    const combinedContent = `${notesOutput}\n\n---\n\n## Original Transcript\n\n${fixedText}`;

    writeFileAtomic(finalPath, combinedContent);
    log.info(`✓ Study notes saved: ${finalPath}`);

    // Clean up intermediate files
    fs.unlinkSync(fixedTranscriptPath); // remove .raw.fixed.md
    const rawTxtPath = fixedTranscriptPath.replace('.raw.fixed.md', '.raw.txt');
    if (fs.existsSync(rawTxtPath)) {
      fs.unlinkSync(rawTxtPath); // remove .raw.txt
    }

    return finalPath;
  } catch (err) {
    throw new Error(`Claude CLI failed (notes): ${err.message}`);
  }
}

function pickFramesByWindow(frameFiles, frameTimes) {
  const byWindow = new Map();
  for (const f of frameFiles) {
    if (frameTimes[f] === undefined) continue;
    const w = Math.floor(frameTimes[f] / PLACEMENT_WINDOW_SECONDS);
    if (!byWindow.has(w) || frameTimes[f] >= frameTimes[byWindow.get(w)]) byWindow.set(w, f);
  }
  return [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([window, file]) => ({ window, file }));
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// One-line progress bar. Printed as a normal log line (not redrawn in place), because
// several videos log at once and a redrawn line would be overwritten by their output.
function progressBar(done, total, width = 24) {
  const filled = Math.round((done / total) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total}`;
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

async function generateDocx(notesPath, framesDir, segmentsPath) {
  const outputDir = path.dirname(notesPath);
  const baseName = path.basename(notesPath, '.md');
  const docxPath = path.join(outputDir, `${baseName}.docx`);

  log.info(`[docx] Inserting screenshots and generating DOCX...`);

  const notesContent = fs.readFileSync(notesPath, 'utf-8');
  const readJson = (p, fallback) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : fallback;
  const framesDirName = path.basename(framesDir);
  const captions = readJson(path.join(framesDir, 'captions.json'), {});
  const frameTimes = readJson(path.join(framesDir, 'frames.json'), {});
  const segments = readJson(segmentsPath, []);
  const descriptions = readJson(path.join(framesDir, 'descriptions.json'), {});

  // captions.json only lists frames that survived dedupe and classification.
  const keptFiles = Object.keys(captions).filter(f => fs.existsSync(path.join(framesDir, f))).sort();
  const chosen = pickFramesByWindow(keptFiles, frameTimes).map(({ window, file }) => {
    const start = window * PLACEMENT_WINDOW_SECONDS;
    const end = start + PLACEMENT_WINDOW_SECONDS;
    const speech = segments
      .filter(s => s.start < end && s.end > start)
      .map(s => s.text)
      .join(' ')
      .slice(0, 800);
    const local = descriptions[file] || {};
    return {
      file, time: frameTimes[file], caption: captions[file] || '(no caption)', speech,
      description: local.description || '', onScreen: (local.text || '').slice(0, 300),
    };
  });

  if (chosen.length === 0) {
    log.info('No kept frames to insert; converting notes as-is.');
  } else {
    log.info(`Selected ${chosen.length} frame(s) by time window from ${keptFiles.length} kept frame(s).`);
  }

  const prompt = `Here are study notes in markdown, followed by screenshots from the source lecture video in time order. For each screenshot you get its timestamp, a caption, and what the lecturer was saying around that time. Insert a markdown image reference (e.g. "![caption](${framesDirName}/<filename>)") at the point in the notes that covers what the lecturer was saying at that moment. Use each screenshot exactly once, and put each one under a different section when possible. Output the full updated markdown with the image references inserted, and nothing else (no commentary).

Screenshots (in the "${framesDirName}" folder, relative to this document):
${chosen.map(c => `- ${c.file} [${formatTime(c.time)}]: ${c.caption}${c.description ? `\n  Description: ${c.description}` : ''}${c.onScreen ? `\n  On-screen text: ${c.onScreen}` : ''}\n  Lecturer was saying: "${c.speech}"`).join('\n')}

Study notes:
${notesContent}`;

  let finalMarkdown = notesContent;
  if (chosen.length > 0) {
    try {
      finalMarkdown = await runClaude(prompt);
    } catch (err) {
      log.error('Claude CLI failed to insert screenshots, appending them at the end:', err.message);
      finalMarkdown = notesContent;
    }

    // Enforce in code: drop repeated image links (keep the first) ...
    const chosenFiles = new Set(chosen.map(c => c.file));
    const placed = new Set();
    finalMarkdown = finalMarkdown.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (match, target) => {
      const file = path.basename(target.trim());
      if (!chosenFiles.has(file)) return match;
      if (placed.has(file)) return '';
      placed.add(file);
      return match;
    });

    // ... and if the model placed fewer than half, append the rest in time order.
    if (placed.size < chosen.length / 2) {
      const rest = chosen.filter(c => !placed.has(c.file));
      log.info(`Only ${placed.size}/${chosen.length} screenshots placed; appending ${rest.length} under "Lecture screenshots".`);
      finalMarkdown += `\n\n## Lecture screenshots\n\n` +
        rest.map(c => `![${c.caption}](${framesDirName}/${c.file})\n\n*${formatTime(c.time)} — ${c.caption}*`).join('\n\n');
      rest.forEach(c => placed.add(c.file));
    }
    log.info(`Inserted ${placed.size} image reference(s) into notes.`);
  }

  const annotatedPath = path.join(outputDir, `${baseName}.with-images.md`);
  fs.writeFileSync(annotatedPath, finalMarkdown, 'utf-8');

  try {
    await execAsync(`pandoc "${annotatedPath}" -o "${docxPath}"`, { ...EXEC_OPTS, cwd: outputDir });
    log.info(`✓ DOCX generated: ${docxPath}`);
  } catch (err) {
    throw new Error(`pandoc failed (is it installed and on PATH?): ${err.message}`);
  } finally {
    fs.unlinkSync(annotatedPath);
  }

  return docxPath;
}

// Shared across all videos in a run, so stages from different videos overlap:
// e.g. Whisper transcribes video 2 while Claude writes the notes for video 1.
const audioLimit = createLimiter(AUDIO_CONCURRENCY);
const whisperLimit = createLimiter(WHISPER_CONCURRENCY);
const claudeLimit = createLimiter(CLAUDE_CONCURRENCY);

function processSingleVideo(videoPath, seq) {
  return videoContext.run(videoPath, () => processVideoSteps(videoPath, seq));
}

async function processVideoSteps(videoPath, seq) {
  const name = path.basename(videoPath);
  const prefix = sequencePrefix(videoPath, seq);
  const videoStart = Date.now();
  try {
    const finished = getFinishedNotes(videoPath);
    if (finished) {
      log.info(`✓ Skipping ${name}: notes already exist (${finished})`);
      send({ type: 'video', status: 'skipped', info: { notesPath: finished, ...existingOutputs(videoPath, finished) } });
      return true;
    }
    send({ type: 'video', status: 'running' });

    let framesDir = null;

    // Subtitles replace both audio extraction and Whisper when available.
    const srtPath = USE_SUBTITLES ? findSubtitle(videoPath) : null;
    if (!ENABLE_SCREENSHOTS) ['frames', 'filter', 'analyze', 'docx'].forEach(st => emitStage(st, 'skipped'));
    const framesJob = ENABLE_SCREENSHOTS
      // Frame extraction/filtering only needs the source video; it runs alongside the transcript path.
      ? inLimit(audioLimit, 'frames', () => extractFrames(videoPath))
          .then(dir => { framesDir = dir; return track('filter', () => filterFrames(dir)); })
          .then(dir => inLimit(whisperLimit, 'analyze', () => analyzeFrames(dir)))
      : null;
    // Marked handled now so a frames failure during transcription isn't an unhandled
    // rejection; it is still rethrown by the await below.
    framesJob?.catch(() => {});

    let transcriptPath;
    if (srtPath) {
      ['audio', 'whisper'].forEach(st => emitStage(st, 'skipped'));
      transcriptPath = await track('subtitles', () => loadSubtitleTranscript(videoPath, srtPath));
    } else {
      emitStage('subtitles', 'skipped');
      const audioPath = await inLimit(audioLimit, 'audio', () => extractAudio(videoPath));
      transcriptPath = await inLimit(whisperLimit, 'whisper', () => transcribe(audioPath));
    }
    if (framesJob) await framesJob;

    emitStage('fix', 'waiting');
    const notesPath = await claudeLimit(async () => {
      if (srtPath && SKIP_FIX_FOR_SUBTITLES) {
        emitStage('fix', 'skipped');
        const fixedPath = transcriptPath.replace(/\.raw\.txt$/, '.raw.fixed.md');
        writeFileAtomic(fixedPath, fs.readFileSync(transcriptPath, 'utf-8'));
        return track('notes', () => generateNotes(fixedPath, prefix));
      }
      const fixedPath = await track('fix', () => fixTranscript(transcriptPath));
      return track('notes', () => generateNotes(fixedPath, prefix));
    });

    let docxPath = null;
    if (ENABLE_SCREENSHOTS) {
      const segmentsPath = transcriptPath.replace(/\.raw\.txt$/, '.segments.json');
      docxPath = await inLimit(claudeLimit, 'docx', () => generateDocx(notesPath, framesDir, segmentsPath));
    }

    markFinished(videoPath, notesPath);

    log.info(`\n✓ Pipeline complete for ${name}`);
    if (framesDir) log.info(`  Frames: ${framesDir}`);
    log.info(`  Study notes: ${notesPath}`);
    if (docxPath) log.info(`  DOCX: ${docxPath}`);
    log.info('');
    send({ type: 'video', status: 'done', info: { notesPath, docxPath, framesDir } });
    return true;
  } catch (err) {
    log.error(`✗ Failed for ${name} after ${formatDuration(Date.now() - videoStart)}: ${err.message}`);
    log.error(`  Rerun the same command to resume; finished steps are skipped.`);
    send({ type: 'video', status: 'failed', info: { error: err.message } });
    return false;
  }
}

// Output paths of an already-finished video, for the GUI's open buttons.
function existingOutputs(videoPath, notesPath) {
  const docxPath = notesPath.replace(/\.md$/, '.docx');
  const framesDir = path.join(path.dirname(videoPath), `${path.basename(videoPath, path.extname(videoPath))}-frames`);
  return {
    docxPath: fs.existsSync(docxPath) ? docxPath : null,
    framesDir: fs.existsSync(framesDir) ? framesDir : null,
  };
}

// Removes a video's entry from its folder's state file so the next run processes it again.
function resetVideo(videoPath) {
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile(videoPath), 'utf-8')); } catch { return false; }
  if (!(path.basename(videoPath) in state)) return false;
  delete state[path.basename(videoPath)];
  writeFileAtomic(stateFile(videoPath), JSON.stringify(state, null, 2));
  return true;
}

// Walks subfolders too. Every output (audio, notes, state file) is written next to its
// video, so each subfolder ends up with its own notes. Generated "-frames" folders and
// hidden folders are skipped.
function findVideos(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !entry.name.endsWith('-frames')) found.push(...findVideos(full));
    } else if (VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

async function processFolder(folderPath) {
  const videoFiles = findVideos(folderPath);

  // Per-folder sequence info: position in the folder, and a pad width wide enough for
  // the largest number so names sort correctly.
  const seqByVideo = new Map();
  const byDir = new Map();
  for (const f of videoFiles) {
    const d = path.dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(f);
  }
  for (const files of byDir.values()) {
    const nums = files.map((f, i) => {
      const m = path.basename(f).match(/^(\d+)/);
      return m ? parseInt(m[1], 10) : i + 1;
    });
    const width = Math.max(2, String(Math.max(...nums)).length);
    files.forEach((f, i) => seqByVideo.set(f, { position: i + 1, width }));
  }

  if (videoFiles.length === 0) {
    throw new Error(`No video files found in ${folderPath} (searched subfolders too)`);
  }

  send({ type: 'batch', videos: videoFiles.map(f => ({ path: f, name: path.relative(folderPath, f) })) });
  log.info(`Found ${videoFiles.length} video file(s):\n`);
  videoFiles.forEach((f, i) => log.info(`  ${i + 1}. ${path.relative(folderPath, f)}`));
  log.info('\n' + '='.repeat(60) + '\n');

  // All videos start at once; the per-stage limiters decide what actually runs concurrently.
  const batchStart = Date.now();
  let finished = 0;
  const results = await Promise.all(videoFiles.map(async (file) => {
    const ok = await processSingleVideo(file, seqByVideo.get(file));
    finished++;
    const elapsed = Date.now() - batchStart;
    const eta = finished < videoFiles.length ? ` · ~${formatDuration(elapsed / finished * (videoFiles.length - finished))} left` : '';
    log.info(`Progress ${progressBar(finished, videoFiles.length)} videos · ${formatDuration(elapsed)} elapsed${eta}
`);
    return ok;
  }));
  const successCount = results.filter(Boolean).length;

  log.info('='.repeat(60));
  log.info(`✓ Batch complete! Processed ${successCount}/${videoFiles.length} videos`);
  if (successCount < videoFiles.length) {
    log.info(`  ${videoFiles.length - successCount} failed -- rerun the same command to retry them.`);
  }
  return successCount === videoFiles.length;
}

// Processes a video file or a folder of videos. Returns true if every video succeeded.
async function run(input) {
  const runStart = Date.now();
  if (!fs.existsSync(input)) throw new Error(`Path not found: ${input}`);

  let ok;
  if (fs.statSync(input).isDirectory()) {
    ok = await processFolder(input);
  } else {
    send({ type: 'batch', videos: [{ path: input, name: path.basename(input) }] });
    ok = await processSingleVideo(input);
  }
  log.info(`Total time: ${formatDuration(Date.now() - runStart)}`);
  return ok;
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    log.error('Usage: node process.js <path-to-video-or-folder>');
    process.exit(1);
  }

  try {
    await run(input);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
}

// Worker mode: the GUI forks this file and sends {cmd: 'start', input}; the run reports
// progress over IPC and ends with {type: 'end'}.
function worker() {
  process.on('message', async (msg) => {
    if (msg?.cmd !== 'start') return;
    try {
      const ok = await run(msg.input);
      send({ type: 'end', ok });
    } catch (err) {
      log.error(err.message);
      send({ type: 'end', ok: false, error: err.message });
    }
    process.disconnect();
  });
  send({ type: 'ready', settings });
}

module.exports = { run, resetVideo, findVideos, DEFAULT_SETTINGS, SETTINGS_PATH, VIDEO_EXTENSIONS };

if (require.main === module) {
  if (WORKER_MODE) worker();
  else main();
}
