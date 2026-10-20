const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { fork, execFile } = require('child_process');

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
  ].find(isPipelineRoot) || null;
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

async function preflight() {
  const checks = await Promise.all(['ffmpeg', 'pandoc', 'claude'].map(async name => ({ name, path: await whereExe(name) })));
  const venv = pipelineRoot && path.join(pipelineRoot, '.venv', 'Scripts', 'python.exe');
  checks.push({ name: '.venv python', path: venv && fs.existsSync(venv) ? venv : null });
  return checks;
}

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    pipelineRoot,
    running: !!worker,
    checks: await preflight(),
    version: app.getVersion(),
  }));

  ipcMain.handle('app:choose-root', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose the video-notes-pipeline folder (contains process.js)',
      properties: ['openDirectory'],
    });
    if (canceled) return { pipelineRoot };
    if (!isPipelineRoot(filePaths[0])) return { pipelineRoot, error: 'That folder has no process.js' };
    pipelineRoot = filePaths[0];
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
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
