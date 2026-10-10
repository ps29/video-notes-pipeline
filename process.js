const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const crypto = require('crypto');
const execAsync = promisify(exec);

const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 };

// Screenshot stages (frame extraction, Claude frame classification, local-model frame
// analysis, image placement, DOCX). They cost extra CLI calls; set to false to skip them.
const ENABLE_SCREENSHOTS = true;

// Claude model used for every CLI call in the pipeline.
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

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

// Max concurrent jobs per stage when several videos are queued (folder mode).
// Whisper runs on the single GPU, so it stays at 1; ffmpeg is cheap CPU work;
// the Claude CLI steps are network-bound but share your subscription's usage limits.
const AUDIO_CONCURRENCY = 3;
const WHISPER_CONCURRENCY = 1;
const CLAUDE_CONCURRENCY = 2;

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
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

// If a video already has an .srt subtitle file, use it as the transcript instead of
// running Whisper (faster, and human captions are usually more accurate on technical
// terms). Looked up as <videoFolder>_subtitles/<name>.srt, then <videoFolder>/<name>.srt.
const USE_SUBTITLES = true;

// Subtitles are already clean, so the Claude transcript-fix call is skipped for them.
const SKIP_FIX_FOR_SUBTITLES = true;

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

  console.log(`✓ Using subtitles instead of Whisper: ${srtPath}`);
  writeFileAtomic(path.join(outputDir, `${baseName}.segments.json`), JSON.stringify(segments, null, 2));
  writeFileAtomic(transcriptPath, segments.map(s => s.text).join(' '));
  return transcriptPath;
}

async function extractAudio(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const audioPath = path.join(path.dirname(videoPath), `${baseName}.wav`);

  if (fs.existsSync(audioPath)) {
    console.log(`✓ Audio already extracted, skipping: ${audioPath}`);
    return audioPath;
  }

  console.log(`[audio] Extracting audio from ${videoPath}...`);
  const tmpPath = path.join(path.dirname(videoPath), `${baseName}.tmp.wav`);
  try {
    await execAsync(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -y "${tmpPath}"`, EXEC_OPTS);
    fs.renameSync(tmpPath, audioPath);
    console.log(`✓ Audio extracted: ${audioPath}`);
    return audioPath;
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.message}`);
  }
}

// Scene-change threshold: higher = fewer, more distinct candidate frames.
// Screen-capture lecture recordings (slides/code, mostly static camera) have
// much lower scene-score variance than real camera footage: 0.02 is tuned for
// that case. Raise it if too many near-duplicate frames come through.
const SCENE_CHANGE_THRESHOLD = 0.02;

async function extractFrames(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const framesDir = path.join(path.dirname(videoPath), `${baseName}-frames`);

  console.log(`[frames] Extracting candidate frames from ${videoPath}...`);
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
    console.log(`✓ Extracted ${frameCount} candidate frame(s): ${framesDir}`);
    return framesDir;
  } catch (err) {
    console.error('ffmpeg frame extraction failed:', err.message);
    process.exit(1);
  }
}

// How many frames to classify with Claude at once. Keeps a lecture video's
// worth of frames from fully serializing while staying under API rate limits.
const FRAME_CLASSIFY_CONCURRENCY = 4;

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

  console.log(`[filter] Classifying ${frames.length} unique candidate frame(s) with Claude (${FRAME_CLASSIFY_CONCURRENCY} at a time)...`);

  const keptFlags = await mapWithConcurrency(frames, FRAME_CLASSIFY_CONCURRENCY, async (frameFile) => {
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
      console.error(`Frame classification failed for ${frameFile}:`, err.message);
      return { useful: false, caption: '' };
    }
  });

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

  console.log(`✓ Kept ${keptFrames.length}/${frames.length} useful frame(s) after removing duplicates: ${framesDir}`);
  return framesDir;
}

// Describes the kept frames (and transcribes their on-screen text) with a local vision model
// via frame_analyze.py. Optional: on any failure the pipeline continues with Claude's captions.
async function analyzeFrames(framesDir) {
  console.log(`[analyze] Describing kept frames with the local vision model...`);
  try {
    const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    await execAsync(`"${venvPython}" "${path.join(__dirname, 'frame_analyze.py')}" "${framesDir}"`, EXEC_OPTS);
    console.log(`✓ Frame descriptions saved: ${path.join(framesDir, 'descriptions.json')}`);
  } catch (err) {
    console.warn(`Local frame analysis skipped (run setup-llama.ps1?): ${(err.stderr || err.message).toString().trim().split('\n').pop()}`);
  }
  return framesDir;
}

// SSIM above this between a kept frame and the last kept frame means the same
// slide/diagram is on screen (pen or hand movement only), so the frame is dropped.
// Measured on a lecture video: same-slide neighbours scored ~0.84-0.96.
const SSIM_DUPLICATE_THRESHOLD = 0.9;

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
    console.log(`✓ Raw transcript already exists, skipping: ${transcriptPath}`);
    return transcriptPath;
  }

  console.log(`[transcribe] Transcribing ${path.basename(audioPath)} with whisper.cpp (GPU)...`);
  try {
    const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    const { stdout } = await execAsync(`"${venvPython}" "${path.join(__dirname, 'transcribe.py')}" "${audioPath}"`, EXEC_OPTS);
    writeFileAtomic(transcriptPath, stdout.trim());
    console.log(`✓ Raw transcript saved: ${transcriptPath}`);
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
    console.log(`✓ Fixed transcript already exists, skipping: ${fixedPath}`);
    return fixedPath;
  }

  console.log(`[fix] Fixing transcript with Claude...`);
  const prompt = `You are correcting a speech-to-text transcript of a computer science lecture or educational video. Fix mis-transcribed technical terms, names, programming concepts, and phrases using context. Preserve the original meaning and structure. Output only the corrected transcript, nothing else.

Transcript to fix:
${rawText}`;

  try {
    const output = await runClaude(prompt);
    if (!output) throw new Error('empty response');
    writeFileAtomic(fixedPath, output);
    console.log(`✓ Fixed transcript saved: ${fixedPath}`);
    return fixedPath;
  } catch (err) {
    throw new Error(`Claude CLI failed (transcript fix): ${err.message}`);
  }
}

async function generateNotes(fixedTranscriptPath) {
  const fixedText = fs.readFileSync(fixedTranscriptPath, 'utf-8');
  const baseName = path.basename(fixedTranscriptPath, path.extname(fixedTranscriptPath)).replace('.raw', '');
  const outputDir = path.dirname(fixedTranscriptPath);

  console.log(`[notes] Generating study notes with Claude...`);
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
    // videos, so the source video's leading number is prefixed to keep every name unique
    // (and the files in lecture order).
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 60);
    const videoNumber = path.basename(fixedTranscriptPath).match(/^(\d+)/);
    const filename = `${videoNumber ? `${videoNumber[1]}-` : ''}${slug}.md`;

    const finalPath = path.join(outputDir, filename);

    // Create combined markdown: transcript + notes
    const combinedContent = `${notesOutput}\n\n---\n\n## Original Transcript\n\n${fixedText}`;

    writeFileAtomic(finalPath, combinedContent);
    console.log(`✓ Study notes saved: ${finalPath}`);

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

// Screenshots are chosen by lecture time: the timeline is split into windows and
// each window contributes its last useful frame (the most complete version of a
// diagram that builds up over time).
const PLACEMENT_WINDOW_SECONDS = 30;

function pickFramesByWindow(frameFiles, frameTimes) {
  const byWindow = new Map();
  for (const f of frameFiles) {
    if (frameTimes[f] === undefined) continue;
    const w = Math.floor(frameTimes[f] / PLACEMENT_WINDOW_SECONDS);
    if (!byWindow.has(w) || frameTimes[f] >= frameTimes[byWindow.get(w)]) byWindow.set(w, f);
  }
  return [...byWindow.entries()].sort((a, b) => a[0] - b[0]).map(([window, file]) => ({ window, file }));
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

async function generateDocx(notesPath, framesDir, segmentsPath) {
  const outputDir = path.dirname(notesPath);
  const baseName = path.basename(notesPath, '.md');
  const docxPath = path.join(outputDir, `${baseName}.docx`);

  console.log(`[docx] Inserting screenshots and generating DOCX...`);

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
    console.log('No kept frames to insert; converting notes as-is.');
  } else {
    console.log(`Selected ${chosen.length} frame(s) by time window from ${keptFiles.length} kept frame(s).`);
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
      console.error('Claude CLI failed to insert screenshots, appending them at the end:', err.message);
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
      console.log(`Only ${placed.size}/${chosen.length} screenshots placed; appending ${rest.length} under "Lecture screenshots".`);
      finalMarkdown += `\n\n## Lecture screenshots\n\n` +
        rest.map(c => `![${c.caption}](${framesDirName}/${c.file})\n\n*${formatTime(c.time)} — ${c.caption}*`).join('\n\n');
      rest.forEach(c => placed.add(c.file));
    }
    console.log(`Inserted ${placed.size} image reference(s) into notes.`);
  }

  const annotatedPath = path.join(outputDir, `${baseName}.with-images.md`);
  fs.writeFileSync(annotatedPath, finalMarkdown, 'utf-8');

  try {
    await execAsync(`pandoc "${annotatedPath}" -o "${docxPath}"`, { ...EXEC_OPTS, cwd: outputDir });
    console.log(`✓ DOCX generated: ${docxPath}`);
  } catch (err) {
    fs.unlinkSync(annotatedPath);
    console.error('pandoc failed (is it installed and on PATH?):', err.message);
    process.exit(1);
  }
  fs.unlinkSync(annotatedPath);

  return docxPath;
}

// Shared across all videos in a run, so stages from different videos overlap:
// e.g. Whisper transcribes video 2 while Claude writes the notes for video 1.
const audioLimit = createLimiter(AUDIO_CONCURRENCY);
const whisperLimit = createLimiter(WHISPER_CONCURRENCY);
const claudeLimit = createLimiter(CLAUDE_CONCURRENCY);

async function processSingleVideo(videoPath) {
  const name = path.basename(videoPath);
  try {
    const finished = getFinishedNotes(videoPath);
    if (finished) {
      console.log(`✓ Skipping ${name}: notes already exist (${finished})`);
      return true;
    }

    let framesDir = null;

    // Subtitles replace both audio extraction and Whisper when available.
    const srtPath = USE_SUBTITLES ? findSubtitle(videoPath) : null;
    const framesJob = ENABLE_SCREENSHOTS
      // Frame extraction/filtering only needs the source video; it runs alongside the transcript path.
      ? audioLimit(() => extractFrames(videoPath)).then(dir => { framesDir = dir; return filterFrames(dir); })
          .then(dir => whisperLimit(() => analyzeFrames(dir)))
      : null;

    let transcriptPath;
    if (srtPath) {
      transcriptPath = loadSubtitleTranscript(videoPath, srtPath);
    } else {
      const audioPath = await audioLimit(() => extractAudio(videoPath));
      transcriptPath = await whisperLimit(() => transcribe(audioPath));
    }
    if (framesJob) await framesJob;

    const notesPath = await claudeLimit(async () => {
      if (srtPath && SKIP_FIX_FOR_SUBTITLES) {
        const fixedPath = transcriptPath.replace(/\.raw\.txt$/, '.raw.fixed.md');
        writeFileAtomic(fixedPath, fs.readFileSync(transcriptPath, 'utf-8'));
        return generateNotes(fixedPath);
      }
      return generateNotes(await fixTranscript(transcriptPath));
    });

    let docxPath = null;
    if (ENABLE_SCREENSHOTS) {
      const segmentsPath = transcriptPath.replace(/\.raw\.txt$/, '.segments.json');
      docxPath = await claudeLimit(() => generateDocx(notesPath, framesDir, segmentsPath));
    }

    markFinished(videoPath, notesPath);

    console.log(`\n✓ Pipeline complete for ${name}`);
    if (framesDir) console.log(`  Frames: ${framesDir}`);
    console.log(`  Study notes: ${notesPath}`);
    if (docxPath) console.log(`  DOCX: ${docxPath}`);
    console.log('');
    return true;
  } catch (err) {
    console.error(`✗ Failed for ${name}: ${err.message}`);
    console.error(`  Rerun the same command to resume; finished steps are skipped.`);
    return false;
  }
}

async function processFolder(folderPath) {
  const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.m4v'];

  // Walks subfolders too. Every output (audio, notes, state file) is written next to its
  // video, so each subfolder ends up with its own notes. Generated "-frames" folders and
  // hidden folders are skipped.
  function findVideos(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !entry.name.endsWith('-frames')) found.push(...findVideos(full));
      } else if (videoExtensions.includes(path.extname(entry.name).toLowerCase())) {
        found.push(full);
      }
    }
    return found;
  }

  const videoFiles = findVideos(folderPath);

  if (videoFiles.length === 0) {
    console.error(`No video files found in ${folderPath} (searched subfolders too)`);
    process.exit(1);
  }

  console.log(`Found ${videoFiles.length} video file(s):\n`);
  videoFiles.forEach((f, i) => console.log(`  ${i + 1}. ${path.relative(folderPath, f)}`));
  console.log('\n' + '='.repeat(60) + '\n');

  // All videos start at once; the per-stage limiters decide what actually runs concurrently.
  const results = await Promise.all(videoFiles.map(processSingleVideo));
  const successCount = results.filter(Boolean).length;

  console.log('='.repeat(60));
  console.log(`✓ Batch complete! Processed ${successCount}/${videoFiles.length} videos`);
  if (successCount < videoFiles.length) {
    console.log(`  ${videoFiles.length - successCount} failed -- rerun the same command to retry them.`);
  }
}

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.error('Usage: node process.js <path-to-video-or-folder>');
    process.exit(1);
  }

  if (!fs.existsSync(input)) {
    console.error(`Path not found: ${input}`);
    process.exit(1);
  }

  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    await processFolder(input);
  } else {
    await processSingleVideo(input);
  }
}

main();
