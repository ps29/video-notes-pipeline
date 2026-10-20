// Checks the pipeline's external dependencies and explains how to install anything missing.
// Nothing is installed: this only looks, and runs version commands.
//
//   node deps-check.js            table of results + install instructions
//   node deps-check.js --deep     also run the GPU test and a Claude login test (one short request)
//   node deps-check.js --models   also list Whisper/vision models from Hugging Face
//   node deps-check.js --json     machine-readable output (used by CI)
//
// The GUI's Dependencies tab calls checkAll / deepTests / fetchModels directly.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const VENV_PYTHON = path.join(ROOT, '.venv', 'Scripts', 'python.exe');

// When each dependency is needed. "always" ones are reported as blockers before a run.
const NEED = {
  always: 'Every run',
  screenshots: 'Runs with screenshots on',
  noSubtitles: 'Videos without .srt subtitles',
  optional: 'Optional',
};

// ---------- process helpers (never throw) ----------

function run(cmd, args, { timeout = 15000, input, env } = {}) {
  return new Promise(resolve => {
    // .cmd/.bat shims (npm-installed CLIs) need a shell on Windows.
    const shell = /\.(cmd|bat)$/i.test(cmd);
    const quoted = shell ? [`"${cmd}"`, ...args.map(a => `"${a}"`)] : [cmd, ...args];
    const child = execFile(quoted[0], quoted.slice(1), { timeout, env, windowsHide: true, shell, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '', error: err }));
    if (input !== undefined) child.stdin.end(input);
  });
}

// First match on PATH (where.exe), or null.
async function locate(name) {
  const res = await run('where', [name], { timeout: 5000 });
  return res.ok ? res.stdout.split(/\r?\n/)[0].trim() || null : null;
}

const firstLine = s => (s || '').split(/\r?\n/).find(l => l.trim()) || '';

function loadSettings() {
  try {
    const { DEFAULT_SETTINGS, SETTINGS_PATH } = require('./process.js');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch { /* defaults */ }
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ENABLE_SCREENSHOTS: true, CLAUDE_MODEL: 'claude-haiku-5-5' };
  }
}

async function pythonJson(script, env = {}) {
  if (!fs.existsSync(VENV_PYTHON)) return null;
  const res = await run(VENV_PYTHON, [path.join(ROOT, script), '--check'], { timeout: 20000, env: { ...process.env, ...env } });
  try { return JSON.parse(res.stdout); } catch { return null; }
}

// ---------- individual checks ----------
// Each returns { id, name, purpose, neededFor, need, status, version, path, detail, install }.
// status: ok | missing | warn | off. install: [{ label, command?, url?, note? }].

async function checkTool({ id, name, exe, versionArgs, parseVersion, purpose, need, install }) {
  const found = await locate(exe);
  const base = { id, name, purpose, need, neededFor: NEED[need], install };
  if (!found) return { ...base, status: 'missing', detail: `${exe} was not found on PATH.` };
  const res = await run(found, versionArgs);
  if (!res.ok) return { ...base, status: 'warn', path: found, detail: `Found, but "${exe} ${versionArgs.join(' ')}" failed: ${firstLine(res.stderr || res.error?.message)}` };
  return { ...base, status: 'ok', path: found, version: parseVersion(res.stdout || res.stderr) };
}

const checkFfmpeg = () => checkTool({
  id: 'ffmpeg', name: 'ffmpeg', exe: 'ffmpeg', versionArgs: ['-version'],
  parseVersion: out => firstLine(out).match(/version (\S+)/)?.[1] || firstLine(out),
  purpose: 'Extracts audio for Whisper and candidate frames for screenshots.',
  need: 'always',
  install: [
    { label: 'winget', command: 'winget install --id Gyan.FFmpeg -e' },
    { label: 'Download', url: 'https://www.gyan.dev/ffmpeg/builds/', note: 'Unzip and add its bin folder to PATH.' },
  ],
});

const checkPandoc = settings => checkTool({
  id: 'pandoc', name: 'pandoc', exe: 'pandoc', versionArgs: ['--version'],
  parseVersion: out => firstLine(out).replace(/^pandoc(\.exe)?\s*/i, ''),
  purpose: 'Converts the notes with screenshots into the .docx file.',
  need: 'screenshots',
  install: [
    { label: 'winget', command: 'winget install --id JohnMacFarlane.Pandoc -e' },
    { label: 'Download', url: 'https://pandoc.org/installing.html' },
  ],
}).then(r => (settings.ENABLE_SCREENSHOTS || r.status === 'ok' ? r : { ...r, status: 'off', detail: 'Not needed: screenshots are turned off in Settings.' }));

const checkClaude = () => checkTool({
  id: 'claude', name: 'Claude CLI', exe: 'claude', versionArgs: ['--version'],
  parseVersion: out => firstLine(out),
  purpose: 'Fixes transcripts, writes the notes, and classifies and places screenshots.',
  need: 'always',
  install: [
    { label: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex', note: 'Then run "claude" once and log in. Use "Test Claude login" here to confirm.' },
    { label: 'Docs', url: 'https://code.claude.com/docs/en/setup' },
  ],
});

async function checkPython() {
  const base = {
    id: 'python', name: 'Python (.venv)', need: 'noSubtitles', neededFor: `${NEED.noSubtitles}; vision step`,
    purpose: 'Runs transcribe.py (Whisper) and frame_analyze.py (vision). Expected at .venv\\Scripts\\python.exe in the pipeline folder.',
    install: [
      { label: 'uv (recommended)', command: 'uv sync', note: 'Run in the pipeline folder. Uses pyproject.toml/uv.lock and fetches Python 3.13 itself.' },
      { label: 'Python + venv', command: 'winget install --id Python.Python.3.13 -e; py -3.13 -m venv .venv', note: 'Run in the pipeline folder.' },
      { label: 'Get uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
    ],
  };
  if (!fs.existsSync(VENV_PYTHON)) return { ...base, status: 'missing', detail: `${VENV_PYTHON} does not exist.` };
  const res = await run(VENV_PYTHON, ['--version']);
  const version = firstLine(res.stdout || res.stderr).replace(/^Python\s*/, '');
  if (!res.ok) return { ...base, status: 'warn', path: VENV_PYTHON, detail: 'The .venv exists but Python failed to start. Recreate it.' };
  const wanted = '3.13';
  return {
    ...base, path: VENV_PYTHON, version,
    status: version.startsWith(wanted) ? 'ok' : 'warn',
    detail: version.startsWith(wanted) ? undefined : `pyproject.toml asks for Python ${wanted}.x; the helpers will probably still work.`,
  };
}

// Same environment process.js gives transcribe.py, so the check reports the model a run would use.
const whisperEnv = settings => (settings.WHISPER_MODEL ? { WHISPER_MODEL: settings.WHISPER_MODEL } : {});
const visionEnv = settings => ({
  ...(settings.VISION_MODEL ? { VLM_MODEL: settings.VISION_MODEL } : {}),
  ...(settings.VISION_MMPROJ ? { VLM_MMPROJ: settings.VISION_MMPROJ } : {}),
});

async function checkWhisper(settings) {
  const base = {
    id: 'whisper', name: 'Whisper (transcription)', need: 'noSubtitles', neededFor: NEED.noSubtitles,
    purpose: 'Transcribes the audio. whisper.cpp on the GPU (Vulkan) is preferred; faster-whisper on the CPU is the fallback.',
    install: [
      { label: 'whisper.cpp (GPU)', command: '.\\setup-whisper.ps1', note: 'Run in PowerShell in the pipeline folder. Installs build tools (~6 GB) and builds whisper.cpp. Add -Model <name> to pick a model (see Models below).' },
      { label: 'faster-whisper (CPU)', command: '.\\.venv\\Scripts\\python.exe -m pip install faster-whisper', note: 'No build needed, but slower.' },
    ],
  };
  const info = await pythonJson('transcribe.py', whisperEnv(settings));
  if (!info) return { ...base, status: 'missing', detail: 'Needs the Python .venv first (see above).' };
  const modelName = path.basename(info.model);
  const models = info.models.map(m => m.name);
  const choice = settings.WHISPER_MODEL
    ? 'Chosen by WHISPER_MODEL in Settings.'
    : `The most accurate downloaded model is used${models.length > 1 ? ` (downloaded: ${models.join(', ')})` : ''}. Set WHISPER_MODEL in Settings to choose.`;
  if (info.backend === 'whisper.cpp' && info.whisper_cli_exists && info.model_exists) {
    return { ...base, status: 'ok', path: info.whisper_cli, version: `whisper.cpp · ${modelName}`, detail: choice, info };
  }
  if (info.faster_whisper) {
    const why = !info.whisper_cli_exists ? 'whisper-cli.exe is not built' : !info.model_exists ? `${modelName} is not downloaded` : 'forced by WHISPER_BACKEND';
    return { ...base, status: 'warn', version: 'faster-whisper (CPU)', detail: `Using the CPU fallback because ${why}. It works, but it is much slower than the GPU.`, info };
  }
  const missing = [!info.whisper_cli_exists && 'whisper-cli.exe', !info.model_exists && modelName].filter(Boolean).join(' and ');
  return { ...base, status: 'missing', detail: `No backend: ${missing} missing, and faster-whisper is not installed.`, info };
}

async function checkVulkan() {
  const dll = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll');
  const base = {
    id: 'vulkan', name: 'Vulkan runtime (GPU)', need: 'optional', neededFor: 'GPU speed for Whisper and llama.cpp',
    purpose: 'Lets whisper.cpp and llama.cpp use the GPU. It ships with GPU drivers.',
    install: [
      { label: 'AMD drivers', url: 'https://www.amd.com/en/support/download/drivers.html' },
      { label: 'Note', note: 'For NVIDIA or Intel GPUs, install the vendor\'s current driver. Use "Test GPU" here to confirm Whisper uses it.' },
    ],
  };
  return fs.existsSync(dll)
    ? { ...base, status: 'ok', path: dll }
    : { ...base, status: 'warn', detail: 'vulkan-1.dll not found: transcription will run on the CPU.' };
}

async function checkVision(settings) {
  const base = {
    id: 'vision', name: 'Vision model (screenshots)', need: 'optional', neededFor: 'Screenshot descriptions (optional)',
    purpose: 'Describes each kept screenshot and reads its on-screen text, which helps place images. Without it, the pipeline uses Claude\'s short captions.',
    install: [
      { label: 'Lemonade Server', url: 'https://lemonade-server.ai/', note: 'Start it, then load the vision model it lists. The pipeline uses it automatically when it is running.' },
      { label: 'llama.cpp', command: '.\\setup-llama.ps1', note: 'Run in PowerShell in the pipeline folder. Builds llama-server and downloads Qwen2.5-VL-3B (~3 GB).' },
    ],
  };
  if (!settings.ENABLE_SCREENSHOTS) return { ...base, status: 'off', detail: 'Not needed: screenshots are turned off in Settings.' };
  const info = await pythonJson('frame_analyze.py', visionEnv(settings));
  if (!info) return { ...base, status: 'warn', detail: 'Needs the Python .venv first (see above).' };
  if (info.lemonade_up) return { ...base, status: 'ok', version: `Lemonade · ${info.lemonade_model}`, path: info.lemonade_url, info };
  if (info.llama_server_exists && info.model_exists && info.mmproj_exists) {
    return { ...base, status: 'ok', version: `llama.cpp · ${path.basename(info.model)}`, path: info.llama_server, detail: 'Lemonade is not running, so llama-server is started when needed.', info };
  }
  const missing = [!info.llama_server_exists && 'llama-server.exe', !info.model_exists && path.basename(info.model), !info.mmproj_exists && path.basename(info.mmproj)].filter(Boolean);
  return { ...base, status: 'warn', detail: `Not set up: Lemonade is not running at ${info.lemonade_url}, and ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} missing. Runs continue without it.`, info };
}

// Runs every quick check (version commands only; no network, no Claude requests).
async function checkAll() {
  const settings = loadSettings();
  const results = await Promise.all([
    checkFfmpeg(), checkPandoc(settings), checkClaude(), checkPython(), checkWhisper(settings), checkVulkan(), checkVision(settings),
  ]);
  return { root: ROOT, checkedAt: new Date().toISOString(), settings: { ENABLE_SCREENSHOTS: settings.ENABLE_SCREENSHOTS, CLAUDE_MODEL: settings.CLAUDE_MODEL, WHISPER_MODEL: settings.WHISPER_MODEL }, results };
}

// ---------- deep tests (slower; the Claude one makes a real request) ----------

async function testGpu() {
  const info = await pythonJson('transcribe.py', whisperEnv(loadSettings()));
  const sample = path.join(ROOT, 'tools', 'whisper.cpp', 'samples', 'jfk.wav');
  const base = { id: 'gpu-test', name: 'GPU test (Whisper)' };
  if (!info || !info.whisper_cli_exists || !info.model_exists) return { ...base, status: 'missing', detail: 'whisper.cpp is not set up, so there is nothing to test.' };
  if (!fs.existsSync(sample)) return { ...base, status: 'warn', detail: `Sample audio not found: ${sample}` };
  const started = Date.now();
  const res = await run(info.whisper_cli, ['-m', info.model, '-f', sample, '-nt'], { timeout: 180000 });
  const out = `${res.stdout}\n${res.stderr}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const text = firstLine(res.stdout).trim();
  if (!res.ok) return { ...base, status: 'missing', detail: `whisper-cli failed: ${firstLine(res.stderr)}` };
  const gpu = out.match(/using (Vulkan\d*) backend/);
  return gpu
    ? { ...base, status: 'ok', version: gpu[1], detail: `Transcribed the 11 s sample in ${seconds} s on the GPU: "${text}"` }
    : { ...base, status: 'warn', detail: `Worked, but on the CPU (${seconds} s). Update the GPU driver to use Vulkan.` };
}

async function testClaude() {
  const settings = loadSettings();
  const base = { id: 'claude-test', name: 'Claude login test' };
  const exe = await locate('claude');
  if (!exe) return { ...base, status: 'missing', detail: 'The Claude CLI is not installed.' };
  const res = await run(exe, ['-p', '--model', settings.CLAUDE_MODEL], { timeout: 90000, input: 'Reply with exactly: OK' });
  if (res.ok && /\bOK\b/i.test(res.stdout)) return { ...base, status: 'ok', version: settings.CLAUDE_MODEL, detail: 'Logged in, and the configured model answered.' };
  const reason = firstLine(res.stdout) || firstLine(res.stderr) || res.error?.message || 'no output';
  return { ...base, status: 'missing', detail: `The request failed: ${reason}. Run "claude" in a terminal to log in, and check CLAUDE_MODEL in Settings.` };
}

async function deepTests() {
  return Promise.all([testGpu(), testClaude()]);
}

// ---------- model lists from Hugging Face (information only) ----------

const HF = 'https://huggingface.co';
const WHISPER_REPO = 'ggerganov/whisper.cpp';
// Vision models known to work with llama.cpp's mmproj support. Sizes are fetched live.
const VISION_REPOS = [
  'ggml-org/Qwen3-VL-2B-Instruct-GGUF',
  'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF',
  'Qwen/Qwen3-VL-4B-Instruct-GGUF',
  'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF',
  'Qwen/Qwen3-VL-8B-Instruct-GGUF',
];

async function hfFiles(repo) {
  const res = await fetch(`${HF}/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status} for ${repo}`);
  const data = await res.json();
  return data.siblings.map(s => ({ name: s.rfilename, size: s.size, sha256: s.lfs?.sha256, url: `${HF}/${repo}/resolve/main/${s.rfilename}` }));
}

// Model family and variant from a whisper.cpp file name, e.g. ggml-small.en-q5_1.bin.
function describeWhisper(name) {
  const m = name.match(/^ggml-([a-z0-9-]+?)(\.en)?(?:-(q\d_\d))?\.bin$/);
  if (!m) return null;
  return { family: m[1], english: !!m[2], quant: m[3] || null };
}

// Smallest to largest, matching transcribe.py's accuracy order.
const WHISPER_FAMILIES = ['tiny', 'base', 'small', 'medium', 'large-v1', 'large-v2', 'large-v3-turbo', 'large-v3'];

async function fetchModels() {
  const local = await pythonJson('transcribe.py', whisperEnv(loadSettings()));
  const installed = new Set((local?.models || []).map(m => m.name));
  const inUse = local?.model_exists ? path.basename(local.model) : null;
  const order = f => [WHISPER_FAMILIES.indexOf(f.family), f.english ? 0 : 1, f.quant ? -Number(f.quant[1]) : -99];
  const whisper = (await hfFiles(WHISPER_REPO))
    .filter(f => describeWhisper(f.name) && WHISPER_FAMILIES.includes(describeWhisper(f.name).family))
    .map(f => ({ ...f, ...describeWhisper(f.name) }))
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)];
      return x[0] - y[0] || x[1] - y[1] || y[2] - x[2];
    })
    .map(f => ({
      ...f,
      installed: installed.has(f.name),
      inUse: f.name === inUse,
      // setup-whisper.ps1 downloads ggml-<Model>.bin
      command: `.\\setup-whisper.ps1 -Model ${f.name.replace(/^ggml-|\.bin$/g, '')}`,
    }));

  const visionDir = path.join(ROOT, 'tools', 'models');
  const localVision = new Set(fs.existsSync(visionDir) ? fs.readdirSync(visionDir) : []);
  const vision = await Promise.all(VISION_REPOS.map(async repo => {
    try {
      const files = (await hfFiles(repo)).filter(f => f.name.endsWith('.gguf'))
        .map(f => ({ ...f, installed: localVision.has(f.name) }));
      // A file already in tools/models wins; otherwise the smallest sensible quantization.
      const pick = re => files.filter(f => re.test(f.name)).sort((a, b) => b.installed - a.installed || a.size - b.size)[0];
      const have = re => files.find(f => f.installed && re.test(f.name));
      const model = have(/^(?!mmproj)/i) || pick(/^(?!mmproj).*q4_k_m\.gguf$/i) || pick(/^(?!mmproj).*q8_0\.gguf$/i);
      const mmproj = have(/^mmproj/i) || pick(/^mmproj.*q8_0\.gguf$/i) || pick(/^mmproj.*\.gguf$/i);
      return { repo, url: `${HF}/${repo}`, model, mmproj, modelsDir: visionDir };
    } catch (err) {
      return { repo, url: `${HF}/${repo}`, error: err.message };
    }
  }));
  const settings = loadSettings();
  return {
    whisper, vision, fetchedAt: new Date().toISOString(),
    visionInUse: { model: settings.VISION_MODEL || '', mmproj: settings.VISION_MMPROJ || '' },
  };
}

// ---------- CLI ----------

const ICON = { ok: '✓', warn: '!', missing: '✗', off: '–' };
const mb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

function printResults(results) {
  for (const r of results) {
    console.log(`${ICON[r.status] || '?'} ${r.name.padEnd(28)} ${[r.version, r.detail].filter(Boolean).join(' — ')}`);
  }
  const todo = results.filter(r => r.install && ['missing', 'warn'].includes(r.status));
  for (const r of todo) {
    console.log(`\n${r.name} (${r.neededFor}): ${r.purpose}`);
    for (const i of r.install) {
      console.log(`  ${i.label}: ${i.command || i.url || ''}${i.note ? `\n    ${i.note}` : ''}`);
    }
  }
}

async function cli() {
  const args = new Set(process.argv.slice(2));
  const report = await checkAll();
  if (args.has('--deep')) report.deep = await deepTests();
  if (args.has('--models')) {
    try { report.models = await fetchModels(); } catch (err) { report.models = { error: err.message }; }
  }

  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Pipeline folder: ${report.root}\n`);
    printResults(report.results);
    if (report.deep) { console.log(''); printResults(report.deep); }
    if (report.models?.error) console.log(`\nCould not load models from Hugging Face: ${report.models.error}`);
    else if (report.models) {
      console.log('\nWhisper models (Hugging Face, ggerganov/whisper.cpp):');
      for (const m of report.models.whisper) console.log(`  ${m.installed ? '✓' : ' '} ${m.name.padEnd(34)} ${mb(m.size).padStart(8)}   ${m.command}`);
      console.log('\nVision models (curated):');
      for (const v of report.models.vision) {
        console.log(v.error ? `  ${v.repo}: ${v.error}` : `  ${v.repo.padEnd(42)} ${v.model?.name} (${mb(v.model?.size)}) + ${v.mmproj?.name} (${mb(v.mmproj?.size)})`);
      }
    }
  }
  // Non-zero only when something every run needs is missing.
  process.exitCode = report.results.some(r => r.need === 'always' && r.status === 'missing') ? 1 : 0;
}

module.exports = { checkAll, deepTests, testGpu, testClaude, fetchModels, loadSettings, NEED };

if (require.main === module) cli();
