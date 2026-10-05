const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function extractAudio(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  const audioPath = path.join(path.dirname(videoPath), `${baseName}.wav`);

  console.log(`[1/4] Extracting audio from ${videoPath}...`);
  try {
    execSync(`ffmpeg -i "${videoPath}" -ar 16000 -ac 1 -y "${audioPath}"`, {
      stdio: 'inherit'
    });
    console.log(`✓ Audio extracted: ${audioPath}`);
    return audioPath;
  } catch (err) {
    console.error('ffmpeg failed:', err.message);
    process.exit(1);
  }
}

async function transcribe(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outputDir = path.dirname(audioPath);
  const transcriptPath = path.join(outputDir, `${baseName}.raw.txt`);

  console.log(`\n[2/4] Transcribing audio with faster-whisper...`);
  try {
    const venvPython = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
    const output = execSync(`"${venvPython}" "${path.join(__dirname, 'transcribe.py')}" "${audioPath}"`, {
      encoding: 'utf-8'
    });
    fs.writeFileSync(transcriptPath, output.trim(), 'utf-8');
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

  console.log(`\n[3/4] Fixing transcript with Claude...`);
  const prompt = `You are correcting a speech-to-text transcript of a computer science lecture or educational video. Fix mis-transcribed technical terms, names, programming concepts, and phrases using context. Preserve the original meaning and structure. Output only the corrected transcript, nothing else.

Transcript to fix:
${rawText}`;

  try {
    const output = execSync(`claude -p`, {
      input: prompt,
      encoding: 'utf-8'
    });
    fs.writeFileSync(fixedPath, output.trim(), 'utf-8');
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

  console.log(`\n[4/4] Generating study notes with Claude...`);
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
    const notesOutput = execSync(`claude -p`, {
      input: prompt,
      encoding: 'utf-8'
    }).trim();

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

async function processSingleVideo(videoPath) {
  try {
    const audioPath = await extractAudio(videoPath);
    const transcriptPath = await transcribe(audioPath);
    const fixedPath = await fixTranscript(transcriptPath);
    const notesPath = await generateNotes(fixedPath);

    console.log(`\n✓ Pipeline complete for ${path.basename(videoPath)}`);
    console.log(`  Raw transcript: ${transcriptPath}`);
    console.log(`  Fixed transcript: ${fixedPath}`);
    console.log(`  Study notes: ${notesPath}\n`);
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
