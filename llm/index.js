// Picks the LLM backend for the text and image prompts in process.js (transcript fix, notes,
// frame classification, screenshot placement) from the LLM_* settings.
//
// Every provider exposes the same shape:
//   complete(prompt, { images: [pngPath...], kind: 'text' | 'vision', onProgress }) -> string
//   listModels() -> [{ id, label? }]   (for the Settings dropdown and the dependency check)

// Presets shown in the Settings tab. `protocol` selects the implementation; `local` marks
// servers on this machine, which share the GPU with Whisper and the vision step.
const PROVIDERS = {
  'claude-cli': {
    label: 'Claude CLI (subscription)', protocol: 'claude-cli',
    hint: 'Uses the logged-in "claude" command. No API key needed.',
  },
  anthropic: {
    label: 'Anthropic API', protocol: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY',
    hint: 'Claude through the API with an API key (billed per token).',
  },
  openai: {
    label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY',
    hint: 'OpenAI models with an API key.',
  },
  openrouter: {
    label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY',
    hint: 'Many hosted models behind one OpenAI-compatible API key.',
  },
  ollama: {
    label: 'Ollama (local)', protocol: 'ollama', baseUrl: 'http://localhost:11434', local: true, keyEnv: 'OLLAMA_API_KEY', keyOptional: true,
    hint: 'Open models served by Ollama on this PC. Uses Ollama\'s own API so the context size can be set.',
  },
  lmstudio: {
    label: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', local: true, keyEnv: 'LM_API_TOKEN', keyOptional: true,
    hint: 'Open models served by LM Studio on this PC. Set the context length when loading the model. If "Require authentication" is on in LM Studio, add its API token.',
  },
  lemonade: {
    label: 'Lemonade Server (local)', protocol: 'openai', baseUrl: 'http://localhost:13305/api/v1', local: true, keyEnv: 'LEMONADE_API_KEY', keyOptional: true,
    hint: 'Open models served by Lemonade on this PC (AMD GPU/NPU).',
  },
  custom: {
    label: 'Other OpenAI-compatible server', protocol: 'openai', keyEnv: 'LLM_API_KEY', keyOptional: true,
    hint: 'Any server with an OpenAI-style /chat/completions endpoint (vLLM, llama.cpp server, LocalAI...). API key optional.',
  },
};

function resolveConfig(settings) {
  const id = PROVIDERS[settings.LLM_PROVIDER] ? settings.LLM_PROVIDER : 'claude-cli';
  const preset = PROVIDERS[id];
  const claude = preset.protocol === 'claude-cli' || preset.protocol === 'anthropic';
  const model = (claude ? settings.CLAUDE_MODEL : settings.LLM_MODEL) || '';
  return {
    id,
    ...preset,
    baseUrl: (settings.LLM_BASE_URL || preset.baseUrl || '').replace(/\/+$/, ''),
    model,
    // Claude models all read images; other providers can name a separate vision model.
    visionModel: (!claude && settings.LLM_VISION_MODEL) || model,
    apiKey: preset.keyEnv ? process.env[preset.keyEnv] || '' : '',
    contextTokens: Number(settings.LLM_CONTEXT_TOKENS) || 0,
    maxOutputTokens: Number(settings.LLM_MAX_OUTPUT_TOKENS) || 0,
    timeoutMs: (Number(settings.LLM_TIMEOUT_MINUTES) || 30) * 60 * 1000,
  };
}

const IMPLEMENTATIONS = {
  'claude-cli': () => require('./claude-cli'),
  anthropic: () => require('./anthropic'),
  openai: () => require('./openai-compatible'),
  ollama: () => require('./ollama'),
};

// Returns the configured provider. Nothing is loaded or contacted until first use.
function createLlm(settings, { log } = {}) {
  const config = resolveConfig(settings);
  let impl = null;
  const get = () => (impl ||= IMPLEMENTATIONS[config.protocol]().create(config, { log }));
  // Short name for log lines: "Claude" keeps the CLI's existing messages unchanged.
  const name = config.protocol === 'claude-cli' ? 'Claude'
    : config.protocol === 'anthropic' ? 'Claude API'
      : `${config.label.replace(/ \(.*\)$/, '')}${config.model ? ` (${config.model})` : ''}`;
  return {
    config,
    name,
    local: !!config.local,
    async complete(prompt, opts = {}) {
      if (!config.model && config.protocol !== 'claude-cli') {
        throw new Error(`No model set for ${config.label}. Choose one in Settings → LLM provider.`);
      }
      return cleanOutput(await get().complete(prompt, opts));
    },
    listModels: () => get().listModels(),
  };
}

// Open models often wrap answers in reasoning tags or a markdown code fence; the pipeline
// wants the bare answer.
function cleanOutput(text) {
  let out = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // opening tag swallowed by the server's template
    .trim();
  const fence = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) out = fence[1].trim();
  return out;
}

module.exports = { PROVIDERS, createLlm, resolveConfig, cleanOutput };
