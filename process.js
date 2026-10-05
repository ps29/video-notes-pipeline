const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 };

// Runs the claude CLI with a prompt, passed via a temp file + stdin redirect
// (async child_process.exec doesn't support the `input` option execSync has).
async function runClaude(prompt, extraArgs = '') {
  const tmpFile = path.join(os.tmpdir(), `claude-prompt-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf-8');
  try {
    const { stdout } = await execAsync(`claude -p ${extraArgs} < "${tmpFile}"`, EXEC_OPTS);
    return stdout.trim();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function extractAudio(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const audioPath = path.join(path.dirname(videoPath), `${baseName}.wav`);

  console.log(`[audio] Extracting audio from ${videoPath}...`);
  try {
    await execAsync(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -y "${audioPath}"`, EXEC_OPTS);
    console.log(`✓ Audio extracted: ${audioPath}`);
    return audioPath;
  } catch (err) {
    console.error('ffmpeg failed:', err.message);
    process.exit(1);
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
    await execAsync(
      `ffmpeg -i "${videoPath}" -vf "select='gt(scene,${SCENE_CHANGE_THRESHOLD})',showinfo" -vsync vfr "${path.join(framesDir, 'candidate_%04d.png')}"`,
      EXEC_OPTS
    );
    const frameCount = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).length;
    console.log(`✓ Extracted ${frameCount} candidate frame(s): ${framesDir}`);
    return framesDir;
  } catch (err) {
    console.error('ffmpeg frame extraction failed:', err.message);
    process.exit(1);
  }
}

// How many frames to classify with Claude at once. Keeps a lecture video's
// worth of frames from fully serializing while not flooding the machine
// with dozens of concurrent claude CLI subprocesses.
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
  const frames = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();

  console.log(`[filter] Classifying ${frames.length} candidate frame(s) with Claude (${FRAME_CLASSIFY_CONCURRENCY} at a time)...`);

  const keptFlags = await mapWithConcurrency(frames, FRAME_CLASSIFY_CONCURRENCY, async (frameFile) => {
    const framePath = path.join(framesDir, frameFile);
    const prompt = `Look at the image at this path: ${framePath}

This is a frame extracted from a computer science lecture video. Decide whether it is worth keeping as a reference screenshot in study notes.

Respond with exactly one word, USEFUL or DISCARD, and nothing else.
- USEFUL: the frame shows a diagram, code snippet, chart, equation, slide text, or other reference-worthy visual content.
- DISCARD: the frame is blank, a blurry transition, or just shows a presenter/talking head with no supporting visual.`;

    try {
      const output = await runClaude(prompt, `--add-dir "${framesDir}" --allowedTools Read`);
      return /^USEFUL/i.test(output);
    } catch (err) {
      console.error(`Frame classification failed for ${frameFile}:`, err.message);
      return false;
    }
  });

  let keptCount = 0;
  frames.forEach((frameFile, i) => {
    if (keptFlags[i]) {
      keptCount++;
    } else {
      fs.unlinkSync(path.join(framesDir, frameFile));
    }
  });

  console.log(`✓ Kept ${keptCount}/${frames.length} useful frame(s): ${framesDir}`);
  return framesDir;
}

async function transcribe(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outputDir = path.dirname(audioPath);
  const transcriptPath = path.join(outputDir, `${baseName}.raw.txt`);

  console.log(`[transcribe] Transcribing audio with faster-whisper...`);
  try {
    const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    const { stdout } = await execAsync(`"${venvPython}" "${path.join(__dirname, 'transcribe.py')}" "${audioPath}"`, EXEC_OPTS);
    fs.writeFileSync(transcriptPath, stdout.trim(), 'utf-8');
    console.log(`✓ Raw transcript saved: ${transcriptPath}`);
    return transcriptPath;
  } catch (err) {
    console.error('Transcription failed:', err.message);
    process.exit(1);
  }
}

async function fixTranscript(transcriptPath) {
  const rawText = fs.readFileSync(transcriptPath, 'utf-8');
  const baseName = path.basename(transcriptPath, path.extname(transcriptPath));
  const outputDir = path.dirname(transcriptPath);
  const fixedPath = path.join(outputDir, `${baseName}.fixed.md`);

  console.log(`[fix] Fixing transcript with Claude...`);
  const prompt = `You are correcting a speech-to-text transcript of a computer science lecture or educational video. Fix mis-transcribed technical terms, names, programming concepts, and phrases using context. Preserve the original meaning and structure. Output only the corrected transcript, nothing else.

Transcript to fix:
${rawText}`;

  try {
    const output = await runClaude(prompt);
    fs.writeFileSync(fixedPath, output, 'utf-8');
    console.log(`✓ Fixed transcript saved: ${fixedPath}`);
    return fixedPath;
  } catch (err) {
    console.error('Claude CLI failed:', err.message);
    process.exit(1);
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

End with:
- A **Key Takeaways** section (bullet list of the most important points)
- If relevant, a short **Possible follow-up questions / things to study further** section

Favor depth and clarity over brevity. The goal is for someone to read these notes and come away with a better understanding than if they'd watched the video passively.

Transcript from video:
${fixedText}`;

  try {
    const notesOutput = await runClaude(prompt);

    // Extract title from the markdown (first # heading)
    const titleMatch = notesOutput.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : 'Study Notes';

    // Convert title to filename: lowercase, replace spaces with hyphens, remove special chars
    const filename = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 60) + '.md';

    const finalPath = path.join(outputDir, filename);

    // Create combined markdown: transcript + notes
    const combinedContent = `${notesOutput}\n\n---\n\n## Original Transcript\n\n${fixedText}`;

    fs.writeFileSync(finalPath, combinedContent, 'utf-8');
    console.log(`✓ Study notes saved: ${finalPath}`);

    // Clean up intermediate files
    fs.unlinkSync(fixedTranscriptPath); // remove .raw.fixed.md
    const rawTxtPath = fixedTranscriptPath.replace('.raw.fixed.md', '.raw.txt');
    if (fs.existsSync(rawTxtPath)) {
      fs.unlinkSync(rawTxtPath); // remove .raw.txt
    }

    return finalPath;
  } catch (err) {
    console.error('Claude CLI failed:', err.message);
    process.exit(1);
  }
}

async function generateDocx(notesPath, framesDir) {
  const outputDir = path.dirname(notesPath);
  const baseName = path.basename(notesPath, '.md');
  const docxPath = path.join(outputDir, `${baseName}.docx`);

  console.log(`[docx] Inserting screenshots and generating DOCX...`);

  const notesContent = fs.readFileSync(notesPath, 'utf-8');
  const frameFiles = fs.existsSync(framesDir)
    ? fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort()
    : [];

  if (frameFiles.length === 0) {
    console.log('No kept frames to insert; converting notes as-is.');
  }

  const framesDirName = path.basename(framesDir);
  const prompt = `Here are study notes in markdown, followed by a list of available screenshot filenames extracted from the source lecture video. Insert markdown image references (e.g. "![description](${framesDirName}/<filename>)") at the points in the notes where each screenshot is most relevant (e.g. a diagram next to the section explaining it, a code screenshot next to the code walkthrough). Not every screenshot needs to be used if none of them fit a section well, and don't force irrelevant placements. Output the full updated markdown with the image references inserted, and nothing else (no commentary).

Available screenshot filenames (in the "${framesDirName}" folder, relative to this document):
${frameFiles.map(f => `- ${f}`).join('\n')}

Study notes:
${notesContent}`;

  let finalMarkdown = notesContent;
  if (frameFiles.length > 0) {
    try {
      finalMarkdown = await runClaude(prompt);
    } catch (err) {
      console.error('Claude CLI failed to insert screenshots, converting notes as-is:', err.message);
    }
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

async function processSingleVideo(videoPath) {
  try {
    const audioPath = await extractAudio(videoPath);
    const framesDir = await extractFrames(videoPath);
    await filterFrames(framesDir);
    const transcriptPath = await transcribe(audioPath);
    const fixedPath = await fixTranscript(transcriptPath);
    const notesPath = await generateNotes(fixedPath);
    const docxPath = await generateDocx(notesPath, framesDir);

    console.log(`\n✓ Pipeline complete for ${path.basename(videoPath)}`);
    console.log(`  Frames: ${framesDir}`);
    console.log(`  Raw transcript: ${transcriptPath}`);
    console.log(`  Fixed transcript: ${fixedPath}`);
    console.log(`  Study notes: ${notesPath}`);
    console.log(`  DOCX: ${docxPath}\n`);
    return true;
  } catch (err) {
    console.error(`✗ Failed for ${path.basename(videoPath)}: ${err.message}`);
    return false;
  }
}

async function processFolder(folderPath) {
  const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.webm', '.m4v'];
  const files = fs.readdirSync(folderPath);
  const videoFiles = files.filter(f => videoExtensions.includes(path.extname(f).toLowerCase()));

  if (videoFiles.length === 0) {
    console.error(`No video files found in ${folderPath}`);
    process.exit(1);
  }

  console.log(`Found ${videoFiles.length} video file(s):\n`);
  videoFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('\n' + '='.repeat(60) + '\n');

  let successCount = 0;
  for (const file of videoFiles) {
    const fullPath = path.join(folderPath, file);
    console.log(`Processing [${successCount + 1}/${videoFiles.length}] ${file}`);
    const success = await processSingleVideo(fullPath);
    if (success) successCount++;
  }

  console.log('='.repeat(60));
  console.log(`✓ Batch complete! Processed ${successCount}/${videoFiles.length} videos`);
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
