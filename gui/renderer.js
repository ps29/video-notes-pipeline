// Renderer: stage board, log monitor and settings form. All main-process access goes
// through window.api (gui/preload.js).

const STAGES = ['subtitles', 'audio', 'whisper', 'frames', 'filter', 'analyze', 'fix', 'notes', 'docx'];
const STAGE_LABELS = {
  subtitles: 'srt', audio: 'audio', whisper: 'whisper', frames: 'frames', filter: 'filter',
  analyze: 'vision', fix: 'fix', notes: 'notes', docx: 'docx',
};
const STAGE_WAITING_TEXT = {
  whisper: 'waiting for GPU', analyze: 'waiting for GPU', audio: 'waiting for ffmpeg slot',
  frames: 'waiting for ffmpeg slot', fix: 'waiting for Claude slot', docx: 'waiting for Claude slot',
};

const SETTING_HELP = {
  ENABLE_SCREENSHOTS: 'Extract, classify and insert screenshots, and build the DOCX.',
  CLAUDE_MODEL: 'Model passed to claude -p for every call.',
  USE_SUBTITLES: 'Use a matching .srt instead of Whisper when one exists.',
  SKIP_FIX_FOR_SUBTITLES: 'Skip the Claude transcript-fix call for subtitle transcripts.',
  AUDIO_CONCURRENCY: 'Parallel ffmpeg jobs (audio and frame extraction).',
  WHISPER_CONCURRENCY: 'Parallel GPU jobs (Whisper and the vision model). Keep at 1.',
  CLAUDE_CONCURRENCY: 'Parallel Claude CLI calls for fix/notes/DOCX.',
  FRAME_CLASSIFY_CONCURRENCY: 'Frames classified with Claude at once, per video.',
  SCENE_CHANGE_THRESHOLD: 'ffmpeg scene score for candidate frames. Higher = fewer frames.',
  SSIM_DUPLICATE_THRESHOLD: 'Frames at least this similar to the last kept frame are dropped.',
  PLACEMENT_WINDOW_SECONDS: 'One screenshot per window of this many seconds.',
};

const MAX_LOG_LINES = 20000; // kept in memory
const MAX_DOM_LINES = 4000;  // rendered

const $ = id => document.getElementById(id);

const state = {
  running: false,
  runStart: null,
  runEnd: null,
  result: null, // 'done' | 'failed' | 'stopped'
  videos: new Map(), // path -> { path, name, status, stages, start, end, info }
  logs: [],
  selectedVideo: '',
  settings: null,
};

// ---------- helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
    else if (k.startsWith('dataset_')) node.dataset[k.slice(8)] = v;
    else if (v !== undefined && v !== null) node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const basename = p => p.split(/[\\/]/).pop();

async function call(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    // ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: msg"
    showBanner(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

function showBanner(text, action) {
  const banner = $('banner');
  banner.replaceChildren(text);
  if (action) banner.append(el('button', { textContent: action.label, on: { click: action.fn } }));
  banner.classList.remove('hidden');
}

const hideBanner = () => $('banner').classList.add('hidden');

// ---------- board ----------

function getVideo(videoPath, name) {
  if (!state.videos.has(videoPath)) {
    state.videos.set(videoPath, {
      path: videoPath, name: name || basename(videoPath), status: 'queued',
      stages: {}, stageInfo: {}, start: null, end: null, info: {},
    });
  }
  return state.videos.get(videoPath);
}

function statusText(v) {
  if (v.status === 'failed') return (v.info.error || 'Failed').split('\n')[0];
  if (v.status === 'skipped') return 'Already done (skipped)';
  if (v.status === 'done') return 'Done';
  if (v.status === 'queued') return 'Queued';
  const running = STAGES.filter(s => v.stages[s] === 'running');
  if (running.length) {
    return running.map(s => {
      const info = v.stageInfo[s];
      if (!info || !info.total) return s;
      return info.pct ? `${s} ${info.done}%` : `${s} ${info.done}/${info.total}`;
    }).join(' + ');
  }
  const waiting = STAGES.filter(s => v.stages[s] === 'waiting');
  if (waiting.length) return STAGE_WAITING_TEXT[waiting[0]] || `waiting (${waiting[0]})`;
  return 'Working';
}

function renderBoard() {
  const body = $('board-body');
  if (state.videos.size === 0) {
    body.replaceChildren(el('tr', { class: 'empty' }, el('td', { colSpan: 5, textContent: 'Choose a video or folder and press Start.' })));
    return;
  }
  body.replaceChildren(...[...state.videos.values()].map(renderRow));
}

function renderRow(v) {
  const chips = STAGES.map(s => el('span', {
    class: `chip ${v.stages[s] || ''}`,
    textContent: STAGE_LABELS[s],
    title: `${s}: ${v.stages[s] || 'pending'}`,
  }));

  const elapsed = v.start ? formatDuration((v.end || Date.now()) - v.start) : '';
  const { notesPath, docxPath, framesDir } = v.info;
  const finished = v.status === 'done' || v.status === 'skipped';

  const actions = el('div', { class: 'actions' },
    notesPath ? el('button', { class: 'small', textContent: 'Notes', title: notesPath, on: { click: () => call(window.api.open, notesPath) } }) : null,
    docxPath ? el('button', { class: 'small', textContent: 'DOCX', title: docxPath, on: { click: () => call(window.api.open, docxPath) } }) : null,
    framesDir ? el('button', { class: 'small', textContent: 'Frames', title: framesDir, on: { click: () => call(window.api.open, framesDir) } }) : null,
    el('button', { class: 'small', textContent: 'Folder', title: 'Show video in Explorer', on: { click: () => call(window.api.reveal, v.path) } }),
    el('button', { class: 'small', textContent: 'Logs', on: { click: () => selectVideo(v.path) } }),
    finished ? el('button', {
      class: 'small', textContent: 'Reset', disabled: state.running,
      title: 'Forget that this video is finished, so the next run processes it again',
      on: { click: () => resetVideo(v) },
    }) : null,
  );

  return el('tr', { class: state.selectedVideo === v.path ? 'selected' : '', dataset_path: v.path },
    el('td', {}, el('div', { class: 'video-name', textContent: v.name, title: v.path })),
    el('td', {}, el('div', { class: 'stages' }, ...chips)),
    el('td', {}, el('div', { class: `status-text ${v.status}`, textContent: statusText(v), title: v.info.error || '' })),
    el('td', { class: 'time', textContent: elapsed, dataset_path: v.path }),
    el('td', {}, actions),
  );
}

async function resetVideo(v) {
  const ok = await call(window.api.resetVideo, v.path);
  if (ok === undefined) return;
  log({ type: 'log', level: 'info', video: v.path, ts: Date.now(),
    msg: ok ? 'Reset: the next run will process this video again.' : 'Nothing to reset (no finished entry in the state file).' });
  if (ok) {
    v.status = 'queued';
    v.stages = {};
    v.info = {};
    v.start = v.end = null;
    renderBoard();
  }
}

function renderRunStatus() {
  const pill = $('run-state');
  const label = state.running ? 'Running' : { done: 'Finished', failed: 'Finished with errors', stopped: 'Stopped' }[state.result] || 'Idle';
  pill.textContent = label;
  pill.className = `pill ${state.running ? 'running' : state.result || 'idle'}`;
  $('run-elapsed').textContent = state.runStart ? formatDuration((state.runEnd || Date.now()) - state.runStart) : '';

  $('start').disabled = state.running;
  $('stop').disabled = !state.running;
  $('pick-file').disabled = $('pick-folder').disabled = state.running;
  $('settings-save').disabled = $('settings-defaults').disabled = state.running;

  const videos = [...state.videos.values()];
  const total = videos.length;
  const finished = videos.filter(v => ['done', 'skipped', 'failed'].includes(v.status)).length;
  const failed = videos.filter(v => v.status === 'failed').length;
  $('batch-bar').style.width = total ? `${(finished / total) * 100}%` : '0';
  $('batch-summary').textContent = total
    ? `${finished}/${total} videos finished${failed ? ` · ${failed} failed` : ''}${state.running && finished > 0 && finished < total
      ? ` · ~${formatDuration((Date.now() - state.runStart) / finished * (total - finished))} left` : ''}`
    : 'No run yet';
}

// ---------- log ----------

function lineMatches(entry) {
  const levels = [...document.querySelectorAll('.lvl:checked')].map(c => c.value);
  if (!levels.includes(entry.level)) return false;
  if (state.selectedVideo && entry.video !== state.selectedVideo) return false;
  const q = $('log-search').value.trim().toLowerCase();
  return !q || entry.msg.toLowerCase().includes(q);
}

function renderLine(entry) {
  const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false });
  return el('div', { class: `line ${entry.level}` },
    el('span', { class: 'ts', textContent: time }),
    entry.video ? el('span', { class: 'tag', textContent: `[${basename(entry.video)}]`, title: entry.video }) : null,
    el('span', { class: 'msg', textContent: entry.msg }),
  );
}

function scrollLogIfNeeded() {
  if ($('autoscroll').checked) $('log').scrollTop = $('log').scrollHeight;
}

function rebuildLog() {
  const matching = state.logs.filter(lineMatches).slice(-MAX_DOM_LINES);
  $('log').replaceChildren(...matching.map(renderLine));
  scrollLogIfNeeded();
}

function log(entry) {
  // Blank lines are spacing in the CLI output; skip them here.
  if (!entry.msg.trim()) return;
  // Multi-line messages (e.g. "\n✓ Pipeline complete") become separate entries.
  for (const msg of entry.msg.split('\n').filter(l => l.trim())) {
    const e = { ...entry, msg };
    state.logs.push(e);
    if (lineMatches(e)) {
      const box = $('log');
      box.append(renderLine(e));
      if (box.childElementCount > MAX_DOM_LINES) box.firstElementChild.remove();
    }
  }
  if (state.logs.length > MAX_LOG_LINES) state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
  scrollLogIfNeeded();
}

function refreshVideoFilter() {
  const select = $('log-video');
  select.replaceChildren(
    el('option', { value: '', textContent: 'All videos' }),
    ...[...state.videos.values()].map(v => el('option', { value: v.path, textContent: v.name })),
  );
  select.value = state.selectedVideo;
}

function selectVideo(videoPath) {
  state.selectedVideo = state.selectedVideo === videoPath ? '' : videoPath;
  $('log-video').value = state.selectedVideo;
  rebuildLog();
  renderBoard();
}

// ---------- pipeline events ----------

// whisper.cpp prints "progress =  15%"; frame_analyze.py prints "  [3/40] candidate_0012.png".
function trackSubprocessProgress(msg) {
  const v = state.videos.get(msg.video);
  if (!v) return;
  const pct = msg.msg.match(/progress =\s*(\d+)%/);
  const frame = msg.msg.match(/^\s*\[(\d+)\/(\d+)\]/);
  if (pct && v.stages.whisper === 'running') v.stageInfo.whisper = { done: Number(pct[1]), total: 100, pct: true };
  else if (frame && v.stages.analyze === 'running') v.stageInfo.analyze = { done: Number(frame[1]), total: Number(frame[2]) };
  else return;
  const cell = document.querySelector(`tr[data-path="${CSS.escape(v.path)}"] .status-text`);
  if (cell) cell.textContent = statusText(v);
}

function onPipeline(msg) {
  switch (msg.type) {
    case 'log':
      log(msg);
      if (msg.level === 'debug' && msg.video) trackSubprocessProgress(msg);
      break;
    case 'batch':
      for (const v of msg.videos) getVideo(v.path, v.name);
      refreshVideoFilter();
      renderBoard();
      break;
    case 'video': {
      const v = getVideo(msg.video);
      v.status = msg.status;
      if (msg.status === 'running') v.start = msg.ts;
      if (['done', 'failed', 'skipped'].includes(msg.status)) v.end = msg.ts;
      Object.assign(v.info, msg.info || {});
      renderBoard();
      renderRunStatus();
      break;
    }
    case 'stage': {
      const v = getVideo(msg.video);
      v.stages[msg.stage] = msg.status;
      if (msg.info) v.stageInfo[msg.stage] = msg.info;
      if (!v.start) v.start = msg.ts;
      if (v.status === 'queued') v.status = 'running';
      renderBoard();
      break;
    }
    case 'end':
      state.result = msg.ok ? 'done' : 'failed';
      break;
    case 'exit':
      state.running = false;
      state.runEnd = msg.ts;
      if (!state.result) state.result = msg.code === 0 ? 'done' : 'stopped';
      // Anything still in flight when the worker died was interrupted.
      for (const v of state.videos.values()) {
        if (v.status === 'running' || v.status === 'queued') {
          v.status = 'failed';
          v.info.error = state.result === 'stopped' ? 'Stopped' : 'Interrupted';
          v.end = msg.ts;
          for (const s of STAGES) if (['running', 'waiting'].includes(v.stages[s])) v.stages[s] = 'failed';
        }
      }
      log({ type: 'log', level: state.result === 'done' ? 'info' : 'warn', video: null, ts: msg.ts,
        msg: state.result === 'stopped' ? 'Run stopped. Start again to resume; finished steps are kept.' : `Worker exited (code ${msg.code}).` });
      renderBoard();
      renderRunStatus();
      break;
  }
}

async function start() {
  const input = $('input-path').value.trim().replace(/^"|"$/g, '');
  if (!input) return showBanner('Choose a video file or folder first.');
  hideBanner();
  state.videos.clear();
  state.selectedVideo = '';
  state.result = null;
  state.runEnd = null;
  refreshVideoFilter();
  renderBoard();
  const res = await call(window.api.start, input);
  if (!res) return;
  state.running = true;
  state.runStart = Date.now();
  try { localStorage.setItem('lastInput', input); } catch { /* storage unavailable */ }
  renderRunStatus();
}

async function stop() {
  await call(window.api.stop);
  state.result = 'stopped';
}

// ---------- settings ----------

async function loadSettings() {
  const res = await call(window.api.getSettings);
  if (!res) return;
  state.settings = res;
  renderSettings(res.values);
}

function renderSettings(values) {
  const form = $('settings-form');
  form.replaceChildren();
  for (const [key, def] of Object.entries(state.settings.defaults)) {
    const id = `set-${key}`;
    const value = values[key];
    const input = typeof def === 'boolean'
      ? el('input', { type: 'checkbox', id, checked: !!value })
      : el('input', { type: typeof def === 'number' ? 'number' : 'text', id, value: String(value), step: 'any' });
    input.dataset.key = key;
    form.append(
      el('label', { htmlFor: id, textContent: key }),
      el('div', { class: 'field' }, input,
        el('span', { class: 'help', textContent: `${SETTING_HELP[key] || ''} Default: ${def}` })),
    );
  }
}

function readSettingsForm() {
  const values = {};
  for (const input of $('settings-form').querySelectorAll('input')) {
    const def = state.settings.defaults[input.dataset.key];
    if (typeof def === 'boolean') values[input.dataset.key] = input.checked;
    else if (typeof def === 'number') {
      const n = Number(input.value);
      if (!Number.isFinite(n)) throw new Error(`${input.dataset.key} must be a number`);
      values[input.dataset.key] = n;
    } else values[input.dataset.key] = input.value.trim();
  }
  return values;
}

async function saveSettings() {
  let values;
  try { values = readSettingsForm(); } catch (err) { $('settings-msg').textContent = err.message; return; }
  if (await call(window.api.saveSettings, values)) {
    $('settings-msg').textContent = 'Saved. Applies to the next run (and to node process.js).';
    state.settings.values = values;
  }
}

// ---------- startup ----------

async function refreshInfo() {
  const info = await call(window.api.info);
  if (!info) return;
  $('choose-root').textContent = info.pipelineRoot ? `Pipeline: ${info.pipelineRoot}` : 'Choose pipeline folder';
  $('checks').replaceChildren(...info.checks.map(c => el('span', {
    class: `check ${c.path ? '' : 'missing'}`,
    textContent: c.path ? c.name : `${c.name} missing`,
    title: c.path || `${c.name} was not found. See the README prerequisites.`,
  })));
  if (!info.pipelineRoot) {
    showBanner('Pipeline folder not found. Choose the folder that contains process.js, .venv and tools/.',
      { label: 'Choose…', fn: chooseRoot });
    $('start').disabled = true;
  } else {
    hideBanner();
    await loadSettings();
  }
}

async function chooseRoot() {
  const res = await call(window.api.chooseRoot);
  if (res?.error) showBanner(res.error, { label: 'Choose…', fn: chooseRoot });
  await refreshInfo();
  renderRunStatus();
}

function init() {
  window.api.onPipeline(onPipeline);

  $('pick-file').addEventListener('click', async () => { const p = await call(window.api.pick, 'file'); if (p) $('input-path').value = p; });
  $('pick-folder').addEventListener('click', async () => { const p = await call(window.api.pick, 'folder'); if (p) $('input-path').value = p; });
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', stop);
  $('choose-root').addEventListener('click', chooseRoot);

  $('log-video').addEventListener('change', e => { state.selectedVideo = e.target.value; rebuildLog(); renderBoard(); });
  document.querySelectorAll('.lvl').forEach(c => c.addEventListener('change', rebuildLog));
  $('log-search').addEventListener('input', rebuildLog);
  $('log-clear').addEventListener('click', () => { state.logs = []; rebuildLog(); });
  $('log-open').addEventListener('click', () => call(window.api.openLogs));

  $('settings-save').addEventListener('click', e => { e.preventDefault(); saveSettings(); });
  $('settings-defaults').addEventListener('click', e => {
    e.preventDefault();
    renderSettings(state.settings.defaults);
    $('settings-msg').textContent = 'Defaults restored in the form. Press Save to apply.';
  });

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tab.dataset.tab}`));
  }));

  // Drop a video or folder onto the window to fill the path.
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    const p = file && window.api.pathForFile ? window.api.pathForFile(file) : null;
    if (p && !state.running) $('input-path').value = p;
  });

  try { $('input-path').value = localStorage.getItem('lastInput') || ''; } catch { /* storage unavailable */ }

  // Ticks the elapsed times while a run is active (time cells only, so buttons aren't
  // rebuilt under the cursor).
  setInterval(() => {
    if (!state.running) return;
    renderRunStatus();
    for (const cell of document.querySelectorAll('td.time')) {
      const v = state.videos.get(cell.dataset.path);
      if (v?.start) cell.textContent = formatDuration((v.end || Date.now()) - v.start);
    }
  }, 1000);

  refreshInfo().then(renderRunStatus);
}

init();
