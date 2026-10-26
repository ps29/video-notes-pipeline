// Ollama through its native API (/api/chat). Its OpenAI-compatible endpoint can't set the
// context size, and Ollama's default context is small enough to silently cut off a lecture
// transcript; here options.num_ctx comes from LLM_CONTEXT_TOKENS.
const fs = require('fs');

function create(config, { log } = {}) {
  async function request(urlPath, init = {}) {
    const url = `${config.baseUrl}${urlPath}`;
    let res;
    try {
      const headers = { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) };
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs || 30000) });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
      throw new Error(`Ollama: could not reach ${url} (${reason}). Is Ollama running?`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = body.match(/"error"\s*:\s*"([^"]+)"/)?.[1] || body.slice(0, 300);
      const hint = res.status === 404 ? ` Pull it first: ollama pull ${init.model || '<model>'}` : '';
      throw new Error(`Ollama returned HTTP ${res.status}: ${detail}.${hint}`);
    }
    return res;
  }

  return {
    async complete(prompt, { images = [], kind = 'text', onProgress } = {}) {
      const model = kind === 'vision' ? config.visionModel : config.model;
      const numCtx = config.contextTokens || 32768;
      // Rough size check (~4 characters per token) so a cut-off transcript is reported.
      const estimate = Math.round(prompt.length / 4);
      if (estimate > numCtx * 0.8) {
        log?.warn(`Prompt is about ${estimate} tokens but LLM_CONTEXT_TOKENS is ${numCtx}; Ollama will drop the start of it. Raise LLM_CONTEXT_TOKENS (if the model and memory allow).`);
      }
      const body = {
        model,
        messages: [{ role: 'user', content: prompt, ...(images.length ? { images: images.map(p => fs.readFileSync(p).toString('base64')) } : {}) }],
        stream: true,
        options: { num_ctx: numCtx, ...(config.maxOutputTokens ? { num_predict: config.maxOutputTokens } : {}) },
      };
      const res = await request('/api/chat', { method: 'POST', body: JSON.stringify(body), timeoutMs: config.timeoutMs, model });

      // Newline-delimited JSON: one object per chunk, the last with done: true.
      let text = '';
      let doneReason = null;
      let lastReport = 0;
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.error) throw new Error(`Ollama: ${event.error}`);
          if (event.message?.content) text += event.message.content;
          if (event.done) doneReason = event.done_reason;
        }
        if (onProgress && text.length - lastReport >= 4000) { lastReport = text.length; onProgress(text.length); }
      }
      if (doneReason === 'length') log?.warn('Ollama stopped at its output limit; the reply may be cut off. Raise LLM_MAX_OUTPUT_TOKENS.');
      return text;
    },

    async listModels() {
      const res = await request('/api/tags', { timeoutMs: 5000 });
      const data = await res.json();
      return (data.models || []).map(m => ({ id: m.name, label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name }));
    },
  };
}

module.exports = { create };
