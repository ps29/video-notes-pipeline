const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork, execFile, execFileSync, spawn } = require('child_process');

// The app only ships the GUI. The pipeline itself (process.js, the Python helpers, .venv
// and tools/) runs from a "pipeline folder" on disk, so pipeline edits apply without a
// rebuild and the installed app can live in Program Files.
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf-8')); } catch { return {}; }
}

function writeConfig(patch) {
  const config = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

const isPipelineRoot = dir => !!dir && fs.existsSync(path.join(dir, 'process.js'));

// First match wins: saved choice, env override, next to the portable/installed exe,
// then the repo this file lives in (npm run gui).
function resolvePipelineRoot() {
  return [
    readConfig().pipelineRoot,
    process.env.VIDEO_NOTES_ROOT,
    process.env.PORTABLE_EXECUTABLE_DIR,
    path.dirname(process.execPath),
    path.resolve(__dirname, '..'),
  ].find(isPipelineRoot) || bundledPipeline();
}

// Packaged builds carry a copy of the pipeline (resources/pipeline). It runs from a writable
// per-user folder, because setup writes .venv, tools/ (Whisper, models) and settings.json next
// to it. Code files are refreshed when the app version changes; nothing else there is touched.
function bundledPipeline() {
  const src = app.isPackaged && path.join(process.resourcesPath, 'pipeline');
  if (!src || !isPipelineRoot(src)) return null;
  const dest = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'VideoNotes', 'pipeline');
  const stamp = path.join(dest, '.bundle-version');
  let current = null;
  try { current = fs.readFileSync(stamp, 'utf-8').trim(); } catch { /* first run */ }
  if (current !== app.getVersion() || !isPipelineRoot(dest)) {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    fs.writeFileSync(stamp, app.getVersion(), 'utf-8');
  }
  return dest;
}

// Tools installed while the app is open (winget adds them to the user or machine PATH) are only
// visible to new processes. This re-reads PATH from the registry so checks and runs find them.
function refreshPath() {
  const read = (key) => {
    try {
      const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
      const out = execFileSync(reg, ['query', key, '/v', 'Path'], { encoding: 'utf-8', windowsHide: true });
      const value = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1]?.trim() || '';
      return value.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
    } catch {
      return '';
    }
  };
  const machine = read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = read('HKCU\\Environment');
  if (machine || user) process.env.Path = [machine, user].filter(Boolean).join(';');
}

let win = null;
let pipelineRoot = null;
let worker = null;
let logStream = null;

function toRenderer(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('pipeline', msg);
}

function writeLog(msg) {
  if (!logStream || msg.type !== 'log') return;
  const time = new Date(msg.ts).toISOString();
  const tag = msg.video ? ` [${path.basename(msg.video)}]` : '';
  logStream.write(`${time} ${msg.level.toUpperCase().padEnd(5)}${tag} ${msg.msg}\n`);
}

function emit(msg) {
  writeLog(msg);
  toRenderer(msg);
}

function pipelineModule() {
  return require(path.join(pipelineRoot, 'process.js'));
}

function startRun(input) {
  if (worker) throw new Error('A run is already in progress');
  if (!pipelineRoot) throw new Error('Choose the pipeline folder first');
  refreshPath();

  const logsDir = path.join(pipelineRoot, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const logPath = path.join(logsDir, `run-${stamp}.log`);
  logStream = fs.createWriteStream(logPath, { flags: 'a' });

  // Electron runs the forked script as plain Node (ELECTRON_RUN_AS_NODE).
  worker = fork(path.join(pipelineRoot, 'process.js'), [], {
    cwd: pipelineRoot,
    env: { ...process.env, VIDEO_NOTES_WORKER: '1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  // Anything printed outside the logger (crashes, warnings from Node) still reaches the log.
  for (const [stream, level] of [[worker.stdout, 'info'], [worker.stderr, 'error']]) {
    stream.setEncoding('utf-8');
    stream.on('data', d => d.split(/\r?\n/).filter(l => l.trim())
      .forEach(l => emit({ type: 'log', level, msg: l, video: null, ts: Date.now() })));
  }

  worker.on('message', msg => {
    if (msg.type === 'ready') return worker.send({ cmd: 'start', input });
    emit(msg);
  });

  worker.on('exit', (code, signal) => {
    emit({ type: 'exit', code, signal, ts: Date.now() });
    worker = null;
    logStream?.end();
    logStream = null;
  });

  emit({ type: 'log', level: 'info', msg: `Started run for ${input} (log: ${logPath})`, video: null, ts: Date.now() });
  return { logPath };
}

// Kills the worker and every process it started (ffmpeg, python, whisper-cli, claude).
// Finished steps survive: the pipeline skips them on the next run.
function stopRun() {
  if (!worker) return false;
  emit({ type: 'log', level: 'warn', msg: 'Stopping run...', video: null, ts: Date.now() });
  execFile('taskkill', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true }, () => {});
  return true;
}

function whereExe(name) {
  return new Promise(resolve => {
    execFile('where', [name], { windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.split(/\r?\n/)[0].trim()));
  });
}

// ---------- API keys ----------
// Saved keys are encrypted with Electron safeStorage (Windows DPAPI, tied to this Windows
// user) in userData/keys.json, and put into this process's environment under the provider's
// variable (e.g. OPENAI_API_KEY). The pipeline worker and the checks inherit them from there.
// A saved key takes precedence over the same variable set in Windows.

const KEYS_PATH = () => path.join(app.getPath('userData'), 'keys.json');
const envBeforeKeys = {};

function llmModule() {
  const file = pipelineRoot && path.join(pipelineRoot, 'llm', 'index.js');
  return file && fs.existsSync(file) ? require(file) : null;
}

// Variable names a key may be saved under: only the providers' own.
function keyEnvNames() {
  const llm = llmModule();
  return new Set(llm ? Object.values(llm.PROVIDERS).map(p => p.keyEnv).filter(Boolean) : []);
}

function readKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_PATH(), 'utf-8')); } catch { return {}; }
}

function applySavedKeys() {
  if (!safeStorage.isEncryptionAvailable()) return;
  for (const [name, encrypted] of Object.entries(readKeys())) {
    if (!(name in envBeforeKeys)) envBeforeKeys[name] = process.env[name];
    try { process.env[name] = safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { /* unreadable: ignore */ }
  }
}

function saveKey(name, value) {
  if (!keyEnvNames().has(name)) throw new Error(`Not an API key variable: ${name}`);
  const keys = readKeys();
  if (value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is unavailable, so the key cannot be stored. Set the environment variable instead.');
    keys[name] = safeStorage.encryptString(value).toString('base64');
    if (!(name in envBeforeKeys)) envBeforeKeys[name] = process.env[name];
    process.env[name] = value;
  } else {
    delete keys[name];
    if (name in envBeforeKeys) {
      if (envBeforeKeys[name] === undefined) delete process.env[name]; else process.env[name] = envBeforeKeys[name];
      delete envBeforeKeys[name];
    }
  }
  fs.mkdirSync(path.dirname(KEYS_PATH()), { recursive: true });
  fs.writeFileSync(KEYS_PATH(), JSON.stringify(keys, null, 2), 'utf-8');
}

// Per variable: saved in the app, and/or present in the environment from Windows.
function keyStatus() {
  const saved = readKeys();
  const status = {};
  for (const name of keyEnvNames()) {
    status[name] = { saved: name in saved, fromWindows: !(name in saved) && !!process.env[name] };
  }
  return status;
}

// deps-check.js lives in the pipeline folder next to process.js. Older pipeline folders
// without it fall back to a PATH lookup for the header badges.
function depsModule() {
  const file = pipelineRoot && path.join(pipelineRoot, 'deps-check.js');
  return file && fs.existsSync(file) ? require(file) : null;
}

const BADGES = ['ffmpeg', 'pandoc', 'claude', 'python', 'whisper'];

async function preflight() {
  const deps = depsModule();
  if (deps) {
    const { results } = await deps.checkAll();
    return results.filter(r => BADGES.includes(r.id))
      .map(r => ({ id: r.id, name: r.name, status: r.status, title: [r.version, r.detail].filter(Boolean).join(' — ') }));
  }
  return Promise.all(['ffmpeg', 'pandoc', 'claude'].map(async name => {
    const found = await whereExe(name);
    return { id: name, name, status: found ? 'ok' : 'missing', title: found || `${name} was not found on PATH` };
  }));
}

// What the run for `input` needs, given the settings and which videos have subtitles.
// Only informs: the renderer lets the user start anyway.
async function precheck(input) {
  const deps = depsModule();
  if (!deps || !fs.existsSync(input)) return { missing: [], warnings: [] };
  const pipeline = pipelineModule();
  const settings = deps.loadSettings();
  const videos = fs.statSync(input).isDirectory() ? pipeline.findVideos(input) : [input];
  const withoutSubs = videos.filter(v => !(settings.USE_SUBTITLES && pipeline.findSubtitle(v))).length;
  const needed = r => r.need === 'always'
    || (r.need === 'screenshots' && settings.ENABLE_SCREENSHOTS)
    || (r.need === 'noSubtitles' && withoutSubs > 0);
  const { results } = await deps.checkAll();
  return {
    videos: videos.length,
    withoutSubs,
    missing: results.filter(r => r.status === 'missing' && needed(r)).map(r => ({ name: r.name, detail: r.detail })),
    warnings: results.filter(r => r.status === 'warn' && needed(r)).map(r => ({ name: r.name, detail: r.detail })),
  };
}

// ---------- setup assistant ----------
// Runs an install option's `action` (defined in deps-check.js) in a visible PowerShell window
// in the pipeline folder, after the user confirms the exact commands. Only actions from the
// last check are runnable; the renderer refers to them by check id and option index.

let lastCheck = null;
const setupWindows = new Map(); // check id -> child process

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

// PowerShell for one action. winget runs without --accept-* flags, so its license and source
// prompts appear in the window for the user to answer.
function actionScript(action) {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }",
  ];
  for (const step of action.steps) {
    if (step.winget) {
      const install = `Write-Host '> winget install --id ${step.winget} -e' -ForegroundColor Cyan; winget install --id ${step.winget} -e`;
      lines.push(step.exe
        ? `if (Get-Command ${psQuote(step.exe)} -ErrorAction SilentlyContinue) { Write-Host '${step.exe} is already installed.' -ForegroundColor Green } else { ${install} }`
        : install);
    } else if (step.script) {
      if (!/^[\w.-]+\.ps1$/.test(step.script)) throw new Error(`Bad script name: ${step.script}`);
      lines.push(`Write-Host '> .\\${step.script}' -ForegroundColor Cyan; & ${psQuote(path.join(pipelineRoot, step.script))}`);
    } else if (step.run) {
      lines.push(`Write-Host ${psQuote(`> ${step.run}`)} -ForegroundColor Cyan; ${step.run}`);
    }
    lines.push('Update-Path');
  }
  lines.push("Write-Host ''; Write-Host 'Done. You can close this window (Video Notes re-checks when it closes).' -ForegroundColor Green; Read-Host 'Press Enter to close'");
  return lines.join('\n');
}

function findAction(checkId, optionIndex) {
  const result = lastCheck?.results.find(r => r.id === checkId);
  const option = result?.install?.[optionIndex];
  if (!option?.action) throw new Error('That setup step is no longer available. Press "Check again" and retry.');
  return { result, option };
}

// Shows what will run, then runs it. Resolves when the window has been opened (or cancelled).
async function runSetup(items, title) {
  if (worker) throw new Error('Stop the run before installing tools.');
  const busy = items.find(i => setupWindows.has(i.result.id));
  if (busy) throw new Error(`Setup for ${busy.result.name} is already running in another window.`);
  const admin = items.some(i => i.option.action.admin);
  const heavy = items.some(i => i.option.action.heavy);
  const detail = [
    'Video Notes will open a PowerShell window in the pipeline folder and run:',
    '',
    ...items.map(i => `• ${i.result.name}: ${i.option.command}`),
    '',
    `Folder: ${pipelineRoot}`,
    'Package licenses and any prompts appear in that window for you to answer.',
    admin ? 'Some steps install system tools and will ask for administrator approval.' : null,
    heavy ? 'This can download several GB and take a while.' : null,
  ].filter(l => l !== null).join('\n');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Run', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
    title: 'Video Notes setup', message: title, detail,
  });
  if (response !== 0) return { started: false };

  const script = items.map(i => actionScript(i.option.action)).join('\n')
    // One combined window shouldn't stop after the first item's "press Enter".
    .replace(/Write-Host ''; Write-Host 'Done\.[^\n]*\n(?=.)/g, '');
  // `start /wait` gives PowerShell its own console (with keyboard input for prompts and the
  // final "press Enter"); the hidden cmd.exe exits when that window closes. The script goes
  // in as -EncodedCommand (UTF-16LE base64), so no quoting can break it.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '"Video Notes setup"', '/wait',
    'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    cwd: pipelineRoot, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
  });
  const ids = items.map(i => i.result.id);
  ids.forEach(id => setupWindows.set(id, child));
  emit({ type: 'log', level: 'info', msg: `Setup started: ${items.map(i => `${i.result.name} (${i.option.command})`).join('; ')}`, video: null, ts: Date.now() });
  child.on('exit', code => {
    ids.forEach(id => setupWindows.delete(id));
    refreshPath();
    emit({ type: 'log', level: 'info', msg: `Setup window closed${code ? ` (exit ${code})` : ''}. Re-checking dependencies.`, video: null, ts: Date.now() });
    toRenderer({ type: 'setup-finished', ids, ts: Date.now() });
  });
  return { started: true };
}

// "Install everything missing": the first runnable option of each missing item that every run
// (or, with screenshots on, every screenshot run) needs, plus Python. Large builds (Whisper,
// llama.cpp) are left to their own buttons.
function missingQuickInstalls() {
  const settings = depsModule().loadSettings();
  const wanted = r => r.need === 'always' || r.need === 'noSubtitles' || (r.need === 'screenshots' && settings.ENABLE_SCREENSHOTS);
  const items = [];
  for (const result of lastCheck?.results || []) {
    if (result.status !== 'missing' || !wanted(result)) continue;
    const optionIndex = (result.install || []).findIndex(o => o.action && !o.action.heavy);
    if (optionIndex !== -1) items.push({ result, option: result.install[optionIndex] });
  }
  return items;
}

// First start after install: the installer's checkbox leaves "open" or "skip" in
// userData/setup-choice.txt. Without it (portable, dev), the assistant opens once.
function takeFirstRunSetup() {
  const config = readConfig();
  const choiceFile = path.join(app.getPath('userData'), 'setup-choice.txt');
  let choice = null;
  try { choice = fs.readFileSync(choiceFile, 'utf-8').trim(); fs.rmSync(choiceFile, { force: true }); } catch { /* none */ }
  if (choice === 'open') { writeConfig({ setupSeen: true }); return true; }
  if (choice === 'skip' || config.setupSeen) { if (!config.setupSeen) writeConfig({ setupSeen: true }); return false; }
  writeConfig({ setupSeen: true });
  return true;
}

let openSetupOnStart = false;

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    refreshPath();
    const info = {
      pipelineRoot,
      running: !!worker,
      checks: await preflight(),
      version: app.getVersion(),
      bundled: !!pipelineRoot && app.isPackaged && pipelineRoot.startsWith(path.join(process.env.LOCALAPPDATA || '', 'VideoNotes')),
      openSetup: openSetupOnStart,
    };
    openSetupOnStart = false;
    return info;
  });

  ipcMain.handle('app:choose-root', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose the video-notes-pipeline folder (contains process.js)',
      properties: ['openDirectory'],
    });
    if (canceled) return { pipelineRoot };
    if (!isPipelineRoot(filePaths[0])) return { pipelineRoot, error: 'That folder has no process.js' };
    pipelineRoot = filePaths[0];
    applySavedKeys();
    writeConfig({ pipelineRoot });
    return { pipelineRoot };
  });

  ipcMain.handle('dialog:pick', async (_e, kind) => {
    const opts = kind === 'folder'
      ? { title: 'Choose a folder of videos', properties: ['openDirectory'] }
      : {
          title: 'Choose a video',
          properties: ['openFile'],
          filters: [{ name: 'Videos', extensions: pipelineModule().VIDEO_EXTENSIONS.map(e => e.slice(1)) }],
        };
    const { canceled, filePaths } = await dialog.showOpenDialog(win, opts);
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('run:start', (_e, input) => startRun(input));
  ipcMain.handle('run:stop', () => stopRun());

  ipcMain.handle('settings:get', () => {
    const { DEFAULT_SETTINGS, SETTINGS_PATH } = pipelineModule();
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch { /* defaults only */ }
    return { defaults: DEFAULT_SETTINGS, values: { ...DEFAULT_SETTINGS, ...saved } };
  });

  ipcMain.handle('settings:save', (_e, values) => {
    if (worker) throw new Error('Settings cannot change while a run is in progress');
    const { SETTINGS_PATH } = pipelineModule();
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(values, null, 2), 'utf-8');
    return true;
  });

  ipcMain.handle('video:reset', (_e, videoPath) => {
    if (worker) throw new Error('Stop the run before resetting a video');
    return pipelineModule().resetVideo(videoPath);
  });

  ipcMain.handle('deps:check', async () => {
    const deps = depsModule();
    if (!deps) throw new Error('This pipeline folder has no deps-check.js. Update it to a newer version.');
    refreshPath();
    lastCheck = await deps.checkAll();
    lastCheck.running = [...setupWindows.keys()];
    lastCheck.quickInstalls = missingQuickInstalls().map(i => i.result.id);
    return lastCheck;
  });
  ipcMain.handle('setup:run', (_e, checkId, optionIndex) => {
    const item = findAction(checkId, optionIndex);
    return runSetup([item], `Set up ${item.result.name}?`);
  });
  ipcMain.handle('setup:run-missing', () => {
    const items = missingQuickInstalls();
    if (!items.length) throw new Error('Nothing missing can be installed automatically. See the individual items.');
    return runSetup(items, `Install ${items.length} missing tool${items.length > 1 ? 's' : ''}?`);
  });
  ipcMain.handle('deps:test', (_e, which) => {
    const deps = depsModule();
    if (which === 'gpu') return deps.testGpu();
    if (which === 'llm') return deps.testLlm();
    throw new Error(`Unknown test: ${which}`);
  });

  ipcMain.handle('llm:providers', () => {
    const llm = llmModule();
    if (!llm) throw new Error('This pipeline folder has no llm/ module. Update it to a newer version.');
    return llm.PROVIDERS;
  });
  // Lists models for the provider settings currently in the form (saved or not).
  ipcMain.handle('llm:models', async (_e, overrides) => {
    const llm = llmModule();
    const settings = { ...depsModule().loadSettings(), ...overrides };
    return llm.createLlm(settings).listModels();
  });
  ipcMain.handle('keys:status', () => keyStatus());
  ipcMain.handle('keys:set', (_e, name, value) => { saveKey(name, String(value || '').trim()); return keyStatus(); });
  ipcMain.handle('deps:models', () => depsModule().fetchModels());
  ipcMain.handle('run:precheck', (_e, input) => precheck(input));

  // Saves one setting (used by "Use this model"); the rest of settings.json is kept.
  ipcMain.handle('settings:set', (_e, key, value) => {
    if (worker) throw new Error('Settings cannot change while a run is in progress');
    const { DEFAULT_SETTINGS, SETTINGS_PATH } = pipelineModule();
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); } catch { /* new file */ }
    saved[key] = value;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(saved, null, 2), 'utf-8');
    return true;
  });

  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('shell:external', (_e, url) => {
    if (!/^https:\/\//i.test(url)) throw new Error('Only https links can be opened');
    return shell.openExternal(url);
  });
  // A PowerShell window in the pipeline folder, for running the install commands shown.
  ipcMain.handle('shell:terminal', () => {
    if (!pipelineRoot) throw new Error('Choose the pipeline folder first');
    spawn('cmd.exe', ['/c', 'start', '"Video Notes"', 'powershell.exe', '-NoExit', '-Command', `Set-Location -LiteralPath '${pipelineRoot.replace(/'/g, "''")}'`],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    return true;
  });

  ipcMain.handle('shell:open', (_e, target) => shell.openPath(target));
  ipcMain.handle('shell:reveal', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('shell:open-logs', () => pipelineRoot && shell.openPath(path.join(pipelineRoot, 'logs')));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Video Notes',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  win.on('ready-to-show', () => {
    win.show();
  });

  win.webContents.on('crashed', () => {
    console.error('FATAL: webContents crashed');
    process.exit(1);
  });

  win.on('unresponsive', () => {
    console.error('WARNING: window unresponsive');
  });

  win.on('close', e => {
    if (!worker) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stop and quit', 'Cancel'],
      defaultId: 1,
      message: 'A run is in progress. Stop it and quit?',
      detail: 'Finished steps are kept; rerunning resumes where it left off.',
    });
    if (choice === 1) e.preventDefault();
    else stopRun();
  });
}

app.whenReady().then(() => {
  pipelineRoot = resolvePipelineRoot();
  applySavedKeys();
  openSetupOnStart = takeFirstRunSetup();
  registerIpc();
  createWindow();
}).catch(err => {
  console.error('FATAL ERROR in app.whenReady:', err);
  process.exit(1);
});

app.on('window-all-closed', () => {
  console.error('DEBUG: window-all-closed event');
  app.quit();
});

process.on('uncaughtException', err => {
  console.error('FATAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});
