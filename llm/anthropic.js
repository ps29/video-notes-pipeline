// Claude through the Anthropic API, using the official SDK (@anthropic-ai/sdk).
// Credentials come from the environment (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
// `ant auth login` profile); the GUI sets ANTHROPIC_API_KEY from the key saved in Settings.
const fs = require('fs');

// Models that accept server-side refusal fallbacks ("default" mode): if a safety classifier
// declines a request, the API re-runs it on Anthropic's recommended fallback model.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function loadSdk() {
  try {
    return require('@anthropic-ai/sdk');
  } catch {
    throw new Error('The Anthropic SDK is not installed. Run "npm install" in the pipeline folder.');
  }
}

function create(config, { log } = {}) {
  const { Anthropic } = loadSdk();
  const client = new Anthropic({ timeout: config.timeoutMs });

  return {
    async complete(prompt, { images = [], kind = 'text', onProgress } = {}) {
      const content = [
        ...images.map(p => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(p).toString('base64') },
        })),
        { type: 'text', text: prompt },
      ];
      const params = {
        model: kind === 'vision' ? config.visionModel : config.model,
        // Streaming, so a large cap doesn't run into HTTP timeouts on long notes.
        max_tokens: config.maxOutputTokens || 64000,
        messages: [{ role: 'user', content }],
      };

      // Streams so long notes don't hit request timeouts; finalMessage() assembles the reply.
      const stream = FALLBACK_MODELS.has(params.model)
        ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : client.messages.stream(params);
      let chars = 0;
      stream.on('text', delta => {
        const before = Math.floor(chars / 4000);
        chars += delta.length;
        if (onProgress && Math.floor(chars / 4000) > before) onProgress(chars);
      });

      let message;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        throw describeError(err, Anthropic);
      }

      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new Error(`Claude declined this request${category ? ` (${category})` : ''}.`);
      }
      const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (message.stop_reason === 'max_tokens') {
        log?.warn(`Claude API reply hit max_tokens (${params.max_tokens}); the output may be cut off. Raise LLM_MAX_OUTPUT_TOKENS.`);
      }
      return text;
    },

    async listModels() {
      try {
        const models = [];
        for await (const m of client.models.list()) models.push({ id: m.id, label: m.display_name });
        return models;
      } catch (err) {
        throw describeError(err, Anthropic);
      }
    },
  };
}

// Most specific first, so the message says what to fix.
function describeError(err, Anthropic) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('Anthropic API key rejected. Check the key in Settings → LLM provider (or ANTHROPIC_API_KEY).');
  if (err instanceof Anthropic.NotFoundError) return new Error(`Anthropic API: model not found (${err.message}). Check the model name in Settings.`);
  if (err instanceof Anthropic.RateLimitError) return new Error('Anthropic API rate limit reached. Lower CLAUDE_CONCURRENCY or try again later.');
  if (err instanceof Anthropic.APIError) return new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
  // Not an API response (connection errors are APIError subclasses too), so with no key in the
  // environment it is the SDK failing to find credentials.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return new Error(`${err.message} (No ANTHROPIC_API_KEY is set. Add a key in Settings → LLM provider.)`);
  }
  return err;
}

module.exports = { create, FALLBACK_MODELS };
