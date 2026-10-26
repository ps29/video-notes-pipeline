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
  CLAUDE_CONCURRENCY: 'Parallel LLM calls for fix/notes/DOCX (any provider). Use 1-2 for a local model.',
  FRAME_CLASSIFY_CONCURRENCY: 'Frames classified by the LLM at once, per video. Use 1-2 for a local model.',
  SCENE_CHANGE_THRESHOLD: 'ffmpeg scene score for candidate frames. Higher = fewer frames.',
  SSIM_DUPLICATE_THRESHOLD: 'Frames at least this similar to the last kept frame are dropped.',
  PLACEMENT_WINDOW_SECONDS: 'One screenshot per window of this many seconds.',
  WHISPER_MODEL: 'Whisper model file in tools\\whisper.cpp\\models. Empty = the most accurate one downloaded. See Dependencies → Models.',
  VISION_MODEL: 'llama.cpp vision model file in tools\\models. Empty = Qwen2.5-VL-3B from setup-llama.ps1.',
  VISION_MMPROJ: 'The matching mmproj file in tools\\models.',
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

function showBanner(text, ...actions) {
  const banner = $('banner');
  banner.replaceChildren(text);
  for (const action of actions.filter(Boolean)) {
    banner.append(el('button', { textContent: action.label, on: { click: action.fn } }));
  }
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
    case 'setup-finished':
      depsState.running = (depsState.running || []).filter(id => !msg.ids.includes(id));
      checkDeps();
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

async function start({ skipCheck = false } = {}) {
  const input = $('input-path').value.trim().replace(/^"|"$/g, '');
  if (!input) return showBanner('Choose a video file or folder first.');
  hideBanner();

  if (!skipCheck) {
    $('start').disabled = true;
    $('start').textContent = 'Checking…';
    const pre = await call(window.api.precheck, input);
    $('start').textContent = 'Start';
    $('start').disabled = false;
    if (pre && (pre.missing.length || pre.warnings.length)) {
      const list = items => items.map(i => i.name).join(', ');
      const text = pre.missing.length
        ? `This run needs ${list(pre.missing)}, which ${pre.missing.length > 1 ? 'were' : 'was'} not found. Videos that need ${pre.missing.length > 1 ? 'them' : 'it'} will fail.`
        : `Heads up: ${pre.warnings.map(w => `${w.name}: ${w.detail}`).join(' ')}`;
      return showBanner(text,
        { label: 'View dependencies', fn: () => { hideBanner(); showTab('deps'); } },
        { label: 'Start anyway', fn: () => start({ skipCheck: true }) });
    }
  }

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

// Edited in the LLM provider card instead of the generic form below it.
const LLM_KEYS = ['LLM_PROVIDER', 'CLAUDE_MODEL', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_VISION_MODEL',
  'LLM_CONTEXT_TOKENS', 'LLM_MAX_OUTPUT_TOKENS', 'LLM_TIMEOUT_MINUTES', 'LOCAL_LLM_GPU_LOCK'];

const llmState = { providers: null, keys: {}, models: [] };

// `quiet` skips the error banner: at startup the pipeline folder may not be chosen yet.
async function loadSettings({ quiet = false } = {}) {
  const get = fn => (quiet ? fn().catch(() => undefined) : call(fn));
  const [res, providers, keys] = await Promise.all([get(window.api.getSettings), get(window.api.llmProviders), get(window.api.keyStatus)]);
  if (!res) return;
  state.settings = res;
  llmState.providers = providers || null;
  llmState.keys = keys || {};
  renderSettings(res.values);
}

function settingInput(key, value, def, extra = {}) {
  const id = `set-${key}`;
  const input = typeof def === 'boolean'
    ? el('input', { type: 'checkbox', id, checked: !!value, ...extra })
    : el('input', { type: typeof def === 'number' ? 'number' : 'text', id, value: String(value ?? ''), step: 'any', ...extra });
  input.dataset.key = key;
  return input;
}

function renderSettings(values) {
  renderLlmCard(values);
  const form = $('settings-form');
  form.replaceChildren();
  for (const [key, def] of Object.entries(state.settings.defaults)) {
    if (LLM_KEYS.includes(key)) continue;
    const input = settingInput(key, values[key], def);
    form.append(
      el('label', { htmlFor: input.id, textContent: key }),
      el('div', { class: 'field' }, input,
        el('span', { class: 'help', textContent: `${SETTING_HELP[key] || ''} Default: ${def === '' ? '(empty)' : def}` })),
    );
  }
}

// One labelled row of the provider card; `show` hides rows that don't apply to the provider.
function llmRow(label, control, help, show = true) {
  return el('div', { class: `llm-row${show ? '' : ' hidden'}` },
    el('label', { htmlFor: control.id || '', textContent: label }),
    el('div', { class: 'field' }, control, help ? el('span', { class: 'help', textContent: help }) : null));
}

function renderLlmCard(values) {
  const card = $('llm-card');
  const providers = llmState.providers;
  if (!providers) {
    card.replaceChildren(el('p', { class: 'muted', textContent: 'This pipeline folder predates LLM provider selection; the Claude CLI is used.' }));
    return;
  }
  const defs = state.settings.defaults;
  const id = providers[values.LLM_PROVIDER] ? values.LLM_PROVIDER : 'claude-cli';
  const p = providers[id];
  const claude = p.protocol === 'claude-cli' || p.protocol === 'anthropic';

  const select = el('select', { id: 'set-LLM_PROVIDER' },
    ...Object.entries(providers).map(([key, prov]) => el('option', { value: key, textContent: prov.label, selected: key === id })));
  select.dataset.key = 'LLM_PROVIDER';
  // Re-render for the new provider, keeping whatever else was typed.
  select.addEventListener('change', () => {
    let current;
    try { current = readSettingsForm(); } catch { current = { ...state.settings.values }; }
    llmState.models = [];
    // The base URL belongs to the previous provider; the new one starts from its default.
    renderLlmCard({ ...current, LLM_PROVIDER: select.value, LLM_BASE_URL: '' });
  });

  const modelKey = claude ? 'CLAUDE_MODEL' : 'LLM_MODEL';
  const modelInput = settingInput(modelKey, values[modelKey], defs[modelKey], { placeholder: claude ? defs.CLAUDE_MODEL : 'e.g. qwen3:14b, gpt-5-mini', autocomplete: 'off' });
  modelInput.setAttribute('list', 'llm-model-list');
  const visionInput = settingInput('LLM_VISION_MODEL', values.LLM_VISION_MODEL, defs.LLM_VISION_MODEL, { placeholder: 'same as the model', autocomplete: 'off' });
  visionInput.setAttribute('list', 'llm-model-list');
  const datalist = el('datalist', { id: 'llm-model-list' }, ...llmState.models.map(m => el('option', { value: m.id, label: m.label || '' })));

  const loadBtn = el('button', { class: 'small', textContent: 'Load models', type: 'button' });
  const modelsMsg = el('span', { class: 'muted' });
  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled = true;
    modelsMsg.textContent = 'Asking the server…';
    let overrides;
    try { overrides = readSettingsForm(); } catch (err) { modelsMsg.textContent = err.message; loadBtn.disabled = false; return; }
    const models = await call(window.api.llmModels, overrides);
    loadBtn.disabled = false;
    if (!models) { modelsMsg.textContent = 'Could not list models (see the message above).'; return; }
    llmState.models = models;
    datalist.replaceChildren(...models.map(m => el('option', { value: m.id, label: m.label || '' })));
    modelsMsg.textContent = models.length ? `${models.length} model(s): pick one from the field's dropdown.` : 'The server listed no models.';
  });

  card.replaceChildren(...[
    el('h2', { class: 'settings-heading', textContent: 'LLM provider' }),
    el('p', { class: 'muted', textContent: 'Which model fixes transcripts, writes the notes, and classifies and places screenshots. Whisper and the screenshot-description model are set separately below.' }),
    llmRow('Provider', select, p.hint),
    llmRow('Base URL', settingInput('LLM_BASE_URL', values.LLM_BASE_URL, defs.LLM_BASE_URL, { placeholder: p.baseUrl || 'http://host:port/v1' }),
      p.baseUrl ? `Leave empty for ${p.baseUrl}.` : 'The server\'s OpenAI-compatible address, usually ending in /v1.', !claude),
    p.keyEnv ? llmRow(`API key${p.keyOptional ? ' (optional)' : ''}`, renderKeyControl(p), null) : null,
    llmRow('Model', el('div', { class: 'inline' }, modelInput, loadBtn, modelsMsg),
      claude ? 'Claude model ID, e.g. claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5.' : 'Press Load models to list what the server has.'),
    llmRow('Vision model', visionInput, 'Used to classify screenshot frames, so it must read images. Leave empty to use the model above.', !claude),
    llmRow('Context (tokens)', settingInput('LLM_CONTEXT_TOKENS', values.LLM_CONTEXT_TOKENS, defs.LLM_CONTEXT_TOKENS),
      'Ollama only. A one-hour lecture transcript is roughly 12k tokens; notes need room on top. Larger needs more memory.', p.protocol === 'ollama'),
    llmRow('Max output tokens', settingInput('LLM_MAX_OUTPUT_TOKENS', values.LLM_MAX_OUTPUT_TOKENS, defs.LLM_MAX_OUTPUT_TOKENS),
      claude ? '0 = 64000 for the Anthropic API.' : '0 = the server\'s default.', p.protocol !== 'claude-cli'),
    llmRow('Timeout (minutes)', settingInput('LLM_TIMEOUT_MINUTES', values.LLM_TIMEOUT_MINUTES, defs.LLM_TIMEOUT_MINUTES),
      'Per request. Local models can take many minutes on long notes.', p.protocol !== 'claude-cli'),
    llmRow('Share GPU lock', settingInput('LOCAL_LLM_GPU_LOCK', values.LOCAL_LLM_GPU_LOCK, defs.LOCAL_LLM_GPU_LOCK),
      'Make the local LLM take turns with Whisper and the vision model on the GPU. Turn off if your GPU has memory for all of them.', !!p.local),
    p.local ? el('p', { class: 'muted note', textContent: 'Tip: keep CLAUDE_CONCURRENCY and FRAME_CLASSIFY_CONCURRENCY at 1-2 for a local model; it serves one request at a time anyway.' }) : null,
    datalist,
  ].filter(Boolean));
  // Hidden fields still hold their values, so switching providers loses nothing.
  for (const key of LLM_KEYS) {
    if (!card.querySelector(`[data-key="${key}"]`)) {
      const hidden = settingInput(key, values[key], defs[key]);
      hidden.classList.add('hidden');
      card.append(hidden);
    }
  }
}

// Password field for the provider's key. Keys are saved separately from settings.json,
// encrypted for this Windows user.
function renderKeyControl(p) {
  const status = llmState.keys[p.keyEnv] || {};
  const input = el('input', { type: 'password', id: 'llm-key', placeholder: status.saved ? '•••••••• (saved)' : 'Paste the key', autocomplete: 'off' });
  const msg = el('span', {
    class: 'muted',
    textContent: status.saved ? 'Saved (encrypted for this Windows user).'
      : status.fromWindows ? `Using ${p.keyEnv} from your Windows environment.` : 'Not set.',
  });
  const save = el('button', { class: 'small', type: 'button', textContent: 'Save key' });
  save.addEventListener('click', async () => {
    if (!input.value.trim()) { msg.textContent = 'Paste a key first.'; return; }
    const keys = await call(window.api.setKey, p.keyEnv, input.value);
    if (keys) { llmState.keys = keys; input.value = ''; input.placeholder = '•••••••• (saved)'; msg.textContent = 'Saved (encrypted for this Windows user).'; }
  });
  const clear = el('button', { class: 'small', type: 'button', textContent: 'Remove', disabled: !status.saved });
  clear.addEventListener('click', async () => {
    const keys = await call(window.api.setKey, p.keyEnv, '');
    if (keys) { llmState.keys = keys; input.placeholder = 'Paste the key'; clear.disabled = true; msg.textContent = keys[p.keyEnv]?.fromWindows ? `Using ${p.keyEnv} from your Windows environment.` : 'Removed.'; }
  });
  return el('div', {},
    el('div', { class: 'inline' }, input, save, clear),
    el('span', { class: 'help' }, msg, ` Stored outside settings.json and passed to the pipeline as ${p.keyEnv}.`));
}

function readSettingsForm() {
  const values = {};
  for (const input of $('tab-settings').querySelectorAll('[data-key]')) {
    const key = input.dataset.key;
    const def = state.settings.defaults[key];
    if (typeof def === 'boolean') values[key] = input.checked;
    else if (typeof def === 'number') {
      const n = Number(input.value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      values[key] = n;
    } else values[key] = input.value.trim();
  }
  return values;
}

async function saveSettings() {
  let values;
  try { values = readSettingsForm(); } catch (err) { $('settings-msg').textContent = err.message; return; }
  if (await call(window.api.saveSettings, values)) {
    $('settings-msg').textContent = 'Saved. Applies to the next run (and to node process.js).';
    state.settings.values = values;
    // The header badges and Dependencies tab reflect the provider; refresh them.
    depsState.results = null;
    refreshInfo();
  }
}

// ---------- dependencies ----------

const depsState = { results: null, tests: new Map(), models: null, checking: false };

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  if (name === 'deps' && !depsState.results && !depsState.checking) checkDeps();
}

const STATUS_LABEL = { ok: 'OK', warn: 'Check', missing: 'Missing', off: 'Not needed', checking: 'Checking' };

function renderBadges(checks) {
  $('checks').replaceChildren(...checks.map(c => el('span', {
    class: `check ${c.status === 'ok' ? '' : c.status}`,
    textContent: c.status === 'missing' ? `${c.name} missing` : c.name,
    title: `${c.title || c.status} (click for details)`,
    on: { click: () => showTab('deps') },
  })));
}

function linkButton(url, label) {
  return el('a', { href: '#', textContent: label || url, on: { click: e => { e.preventDefault(); call(window.api.openExternal, url); } } });
}

function copyButton(text) {
  const btn = el('button', { class: 'small', textContent: 'Copy' });
  btn.addEventListener('click', async () => {
    await call(window.api.copy, text);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
  return btn;
}

function renderInstall(r) {
  const running = (depsState.running || []).includes(r.id);
  return el('div', { class: 'install' }, ...r.install.map((o, index) => el('div', { class: 'install-row' },
    el('span', { class: 'install-label', textContent: o.label }),
    o.command ? el('code', { textContent: o.command }) : null,
    o.command ? copyButton(o.command) : null,
    o.action ? el('button', {
      class: 'small primary',
      textContent: running ? 'Running…' : o.label === 'Log in' ? 'Log in…' : o.action.heavy ? 'Run setup…' : 'Install…',
      disabled: running || state.running,
      title: o.action.admin ? 'Opens PowerShell; may ask for administrator approval' : 'Shows the command, then runs it in a PowerShell window',
      on: { click: () => runSetup(r.id, index) },
    }) : null,
    o.url ? linkButton(o.url) : null,
    o.note ? el('div', { class: 'install-note', textContent: o.note }) : null,
  )));
}

async function runSetup(checkId, optionIndex) {
  const res = await call(window.api.runSetup, checkId, optionIndex);
  if (res?.started) { depsState.running = [...(depsState.running || []), checkId]; renderDeps(); }
}

async function runMissingSetup() {
  const res = await call(window.api.runMissingSetup);
  if (res?.started) { depsState.running = [...(depsState.running || []), ...(depsState.quickInstalls || [])]; renderDeps(); }
}

function renderDep(r) {
  const open = r.status === 'missing' || r.status === 'warn';
  const install = r.install?.length ? renderInstall(r) : null;
  return el('div', { class: `dep ${r.status}` },
    el('div', { class: 'dep-head' },
      el('span', { class: `status ${r.status}`, textContent: STATUS_LABEL[r.status] || r.status }),
      el('span', { class: 'dep-name', textContent: r.name }),
      r.version ? el('span', { class: 'dep-version', textContent: r.version }) : null,
      r.neededFor ? el('span', { class: 'dep-need', textContent: r.neededFor }) : null,
    ),
    r.purpose ? el('p', { class: 'dep-purpose', textContent: r.purpose }) : null,
    r.detail ? el('p', { class: 'dep-detail', textContent: r.detail }) : null,
    r.path ? el('div', { class: 'dep-path', textContent: r.path }) : null,
    install && (open ? install : el('details', {}, el('summary', { textContent: 'How to install' }), install)),
  );
}

function renderDeps() {
  const results = depsState.results || [];
  $('deps-list').replaceChildren(...results.map(renderDep));
  $('deps-tests').replaceChildren(...[...depsState.tests.values()].map(renderDep));
  const count = s => results.filter(r => r.status === s).length;
  $('deps-summary').textContent = depsState.checking ? 'Checking…'
    : results.length ? `${count('ok')} OK · ${count('warn')} to check · ${count('missing')} missing` : '';
  const quick = (depsState.quickInstalls || []).filter(id => !(depsState.running || []).includes(id));
  $('deps-install-missing').classList.toggle('hidden', depsState.checking || quick.length === 0);
  $('deps-install-missing').textContent = `Install missing (${quick.length})`;
  $('deps-install-missing').disabled = state.running;
}

async function checkDeps() {
  depsState.checking = true;
  $('deps-check').disabled = true;
  renderDeps();
  const report = await call(window.api.checkDeps);
  depsState.checking = false;
  $('deps-check').disabled = false;
  if (report) {
    depsState.results = report.results;
    depsState.running = report.running || [];
    depsState.quickInstalls = report.quickInstalls || [];
    renderBadges(report.results.filter(r => ['ffmpeg', 'pandoc', 'claude', 'python', 'whisper'].includes(r.id))
      .map(r => ({ id: r.id, name: r.name, status: r.status, title: [r.version, r.detail].filter(Boolean).join(' — ') })));
  }
  renderDeps();
}

async function runDepTest(which, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Testing…';
  depsState.tests.set(which, { id: which, name: label, status: 'checking', detail: 'Running…' });
  renderDeps();
  const result = await call(window.api.testDep, which);
  if (result) depsState.tests.set(which, result); else depsState.tests.delete(which);
  button.disabled = false;
  button.textContent = label;
  renderDeps();
}

const formatSize = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

async function loadModels() {
  $('models-load').disabled = true;
  $('models-status').textContent = 'Contacting huggingface.co…';
  const models = await call(window.api.fetchModels);
  $('models-load').disabled = false;
  if (!models) { $('models-status').textContent = 'Could not load the list. Check your connection and try again.'; return; }
  depsState.models = models;
  $('models-status').textContent = `Loaded ${new Date(models.fetchedAt).toLocaleTimeString()}`;
  $('models-load').textContent = 'Reload';
  $('models').classList.remove('hidden');
  renderModels();
}

async function useSetting(pairs, message) {
  for (const [key, value] of pairs) {
    if (await call(window.api.setSetting, key, value) === undefined) return;
  }
  log({ type: 'log', level: 'info', video: null, ts: Date.now(), msg: message });
  await loadSettings();
  await loadModels();
  checkDeps();
}

function renderModels() {
  const models = depsState.models;
  if (!models) return;
  const englishOnly = $('models-english').checked;
  let lastFamily = null;
  $('models-whisper').replaceChildren(...models.whisper
    .filter(m => !englishOnly || m.english || m.family.startsWith('large'))
    .map(m => {
      const status = m.inUse ? 'In use' : m.installed ? 'Downloaded' : '';
      const row = el('tr', { class: m.family !== lastFamily ? 'family-start' : '' },
        el('td', { class: 'mono', textContent: m.name, title: `sha256 ${m.sha256 || 'n/a'}` }),
        el('td', { class: 'size', textContent: formatSize(m.size) }),
        el('td', {}, status ? el('span', { class: `status ${m.inUse ? 'ok' : 'off'}`, textContent: status }) : null),
        el('td', {}, el('code', { textContent: m.command }), ' ', copyButton(m.command)),
        el('td', {}, m.installed && !m.inUse ? el('button', {
          class: 'small', textContent: 'Use', disabled: state.running,
          on: { click: () => useSetting([['WHISPER_MODEL', m.name]], `Whisper model set to ${m.name}.`) },
        }) : null),
      );
      lastFamily = m.family;
      return row;
    }));

  const inUse = models.visionInUse;
  $('models-vision').replaceChildren(...models.vision.map(v => {
    if (v.error) return el('tr', {}, el('td', {}, linkButton(v.url, v.repo)), el('td', { colSpan: 4, class: 'muted', textContent: v.error }));
    const file = f => el('td', {},
      el('span', { class: 'mono', textContent: f.name }), ' ',
      el('span', { class: 'muted', textContent: `(${formatSize(f.size)})` }), ' ',
      f.installed ? el('span', { class: 'status off', textContent: 'Downloaded' }) : linkButton(f.url, 'Download'));
    const ready = v.model.installed && v.mmproj.installed;
    const active = inUse.model ? inUse.model === v.model.name : v.model.name === 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf';
    return el('tr', {},
      el('td', {}, linkButton(v.url, v.repo)),
      file(v.model),
      file(v.mmproj),
      el('td', { class: 'size', textContent: formatSize(v.model.size + v.mmproj.size) }),
      el('td', {}, active && ready ? el('span', { class: 'status ok', textContent: 'In use' })
        : ready ? el('button', {
          class: 'small', textContent: 'Use', disabled: state.running,
          on: { click: () => useSetting([['VISION_MODEL', v.model.name], ['VISION_MMPROJ', v.mmproj.name]], `Vision model set to ${v.model.name}.`) },
        }) : null),
    );
  }));
}

// ---------- startup ----------

async function refreshInfo() {
  const info = await call(window.api.info);
  if (!info) return;
  $('choose-root').textContent = info.pipelineRoot ? `Pipeline: ${info.pipelineRoot}` : 'Choose pipeline folder';
  $('choose-root').title = info.pipelineRoot ? `${info.pipelineRoot}\nClick to use a different pipeline folder.` : '';
  renderBadges(info.checks);
  if (info.openSetup) {
    $('deps-welcome').classList.remove('hidden');
    showTab('deps');
  }
  if (!info.pipelineRoot) {
    showBanner('Pipeline folder not found. Choose the folder that contains process.js, .venv and tools/.',
      { label: 'Choose…', fn: chooseRoot });
    $('start').disabled = true;
  } else {
    hideBanner();
    if (!state.settings) await loadSettings();
  }
}

async function chooseRoot() {
  const res = await call(window.api.chooseRoot);
  if (res?.error) showBanner(res.error, { label: 'Choose…', fn: chooseRoot });
  state.settings = null; // the new folder has its own settings.json
  depsState.results = null;
  await refreshInfo();
  renderRunStatus();
}

function init() {
  window.api.onPipeline(onPipeline);

  $('pick-file').addEventListener('click', async () => { const p = await call(window.api.pick, 'file'); if (p) $('input-path').value = p; });
  $('pick-folder').addEventListener('click', async () => { const p = await call(window.api.pick, 'folder'); if (p) $('input-path').value = p; });
  $('start').addEventListener('click', () => start());
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

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

  $('deps-check').addEventListener('click', checkDeps);
  $('deps-install-missing').addEventListener('click', runMissingSetup);
  $('deps-welcome-close').addEventListener('click', () => $('deps-welcome').classList.add('hidden'));
  $('deps-test-gpu').addEventListener('click', () => runDepTest('gpu', $('deps-test-gpu')));
  $('deps-test-llm').addEventListener('click', () => runDepTest('llm', $('deps-test-llm')));
  $('deps-terminal').addEventListener('click', () => call(window.api.openTerminal));
  $('models-load').addEventListener('click', loadModels);
  $('models-english').addEventListener('change', renderModels);
  // Static links in index.html open in the browser, not inside the app.
  document.querySelectorAll('a[data-href]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    call(window.api.openExternal, a.dataset.href);
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

  // Settings don't depend on the (slower) dependency check behind refreshInfo.
  loadSettings({ quiet: true });
  refreshInfo().then(renderRunStatus);
}

init();
