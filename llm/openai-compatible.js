// Any server with an OpenAI-style /chat/completions endpoint: OpenAI, OpenRouter, LM Studio,
// Lemonade, vLLM, llama.cpp's server, LocalAI... Replies are streamed (SSE): local models can
// take many minutes on long notes, and a non-streaming request would hit Node's 5-minute
// header timeout before the first byte arrives.
const fs = require('fs');

function create(config, { log } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.id === 'openrouter') headers['X-Title'] = 'Video Notes';

  async function request(urlPath, init) {
    const url = `${config.baseUrl}${urlPath}`;
    let res;
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs || 30000) });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'timed out' : err.cause?.code || err.message;
      throw new Error(`${config.label}: could not reach ${url} (${reason}).${config.local ? ' Is the server running?' : ''}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const detail = body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] || body.slice(0, 300);
      const hint = res.status === 401 ? ' Check the API key in Settings → LLM provider.' : res.status === 404 ? ' Check the base URL and model name.' : '';
      throw new Error(`${config.label} returned HTTP ${res.status}: ${detail.replace(/[.\s]*$/, '')}.${hint}`);
    }
    return res;
  }

  return {
    async complete(prompt, { images = [], kind = 'text', onProgress } = {}) {
      const content = images.length === 0 ? prompt : [
        { type: 'text', text: prompt },
        ...images.map(p => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` } })),
      ];
      const body = {
        model: kind === 'vision' ? config.visionModel : config.model,
        messages: [{ role: 'user', content }],
        stream: true,
      };
      if (config.maxOutputTokens) body.max_tokens = config.maxOutputTokens;

      const res = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body), timeoutMs: config.timeoutMs });

      let text = '';
      let finish = null;
      let lastReport = 0;
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const data = line.replace(/^data:\s?/, '').trim();
          if (!line.startsWith('data:') || !data || data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (event.error) throw new Error(`${config.label}: ${event.error.message || JSON.stringify(event.error)}`);
          const choice = event.choices?.[0];
          // Reasoning models may stream their thinking separately (reasoning_content); only
          // the answer is kept.
          if (choice?.delta?.content) text += choice.delta.content;
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
        if (onProgress && text.length - lastReport >= 4000) { lastReport = text.length; onProgress(text.length); }
      }
      if (finish === 'length') {
        log?.warn(`${config.label} stopped at its output limit; the reply may be cut off. Raise LLM_MAX_OUTPUT_TOKENS or the server's limit.`);
      }
      return text;
    },

    async listModels() {
      const res = await request('/models', { method: 'GET', timeoutMs: config.local ? 5000 : 15000 });
      const data = await res.json();
      return (data.data || data.models || []).map(m => ({ id: m.id || m.name })).filter(m => m.id);
    },
  };
}

module.exports = { create };
