// Tests the OpenAI-compatible and Ollama providers against a mock server (node --test).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLlm, cleanOutput } = require('../llm');
const { DEFAULT_SETTINGS } = require('../process.js');

const seen = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== 'Bearer secret') { res.writeHead(401); return res.end('{"error":{"message":"bad token"}}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-a' }, { id: 'mock-vision' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const j = JSON.parse(body);
      const parts = Array.isArray(j.messages[0].content) ? j.messages[0].content : [];
      seen.openai = { model: j.model, stream: j.stream, images: parts.filter(p => p.type === 'image_url').length };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of ['<think>pondering', '</think>', 'USEFUL', '\nA ', 'diagram']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', details: { parameter_size: '8B' } }] }));
    }
    if (req.url === '/api/chat') {
      const j = JSON.parse(body);
      seen.ollama = { model: j.model, numCtx: j.options?.num_ctx, images: (j.messages[0].images || []).length };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const c of ['```markdown\n# Notes', '\n\nBody ', 'text\n```']) res.write(JSON.stringify({ message: { content: c }, done: false }) + '\n');
      return res.end(JSON.stringify({ done: true, done_reason: 'stop' }) + '\n');
    }
    res.writeHead(404); res.end('{"error":"not found"}');
  });
});

let base;
const image = path.join(os.tmpdir(), `llm-test-${process.pid}.png`);
const quietLog = { warn: () => {}, debug: () => {} };

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
test.after(() => { server.close(); fs.rmSync(image, { force: true }); delete process.env.LLM_API_KEY; });

test('OpenAI-compatible: lists models with the key and streams a vision reply', async () => {
  process.env.LLM_API_KEY = 'secret';
  const llm = createLlm({ ...DEFAULT_SETTINGS, LLM_PROVIDER: 'custom', LLM_BASE_URL: `${base}/v1/`, LLM_MODEL: 'mock-a', LLM_VISION_MODEL: 'mock-vision' }, { log: quietLog });
  assert.deepStrictEqual((await llm.listModels()).map(m => m.id), ['mock-a', 'mock-vision']);
  assert.strictEqual(await llm.complete('classify', { images: [image], kind: 'vision' }), 'USEFUL\nA diagram');
  assert.deepStrictEqual(seen.openai, { model: 'mock-vision', stream: true, images: 1 });
});

test('OpenAI-compatible: a 401 names the API key', async () => {
  delete process.env.LLM_API_KEY;
  const llm = createLlm({ ...DEFAULT_SETTINGS, LLM_PROVIDER: 'custom', LLM_BASE_URL: `${base}/v1`, LLM_MODEL: 'mock-a' });
  await assert.rejects(llm.listModels(), /HTTP 401: bad token\. Check the API key/);
});

test('Ollama: sends num_ctx and images, strips the code fence, warns on long prompts', async () => {
  const warnings = [];
  const llm = createLlm({ ...DEFAULT_SETTINGS, LLM_PROVIDER: 'ollama', LLM_BASE_URL: base, LLM_MODEL: 'qwen3:8b', LLM_CONTEXT_TOKENS: 1000 },
    { log: { warn: m => warnings.push(m), debug: () => {} } });
  assert.deepStrictEqual((await llm.listModels()).map(m => m.label), ['qwen3:8b (8B)']);
  assert.strictEqual(await llm.complete('x'.repeat(5000), { images: [image], kind: 'vision' }), '# Notes\n\nBody text');
  assert.deepStrictEqual(seen.ollama, { model: 'qwen3:8b', numCtx: 1000, images: 1 });
  assert.match(warnings.join('\n'), /LLM_CONTEXT_TOKENS is 1000/);
});

test('a provider without a model refuses before contacting anything', async () => {
  const llm = createLlm({ ...DEFAULT_SETTINGS, LLM_PROVIDER: 'lmstudio' });
  await assert.rejects(llm.complete('hi'), /No model set for LM Studio/);
});

test('an unreachable local server says so', async () => {
  const llm = createLlm({ ...DEFAULT_SETTINGS, LLM_PROVIDER: 'lmstudio', LLM_BASE_URL: 'http://127.0.0.1:9/v1', LLM_MODEL: 'x' });
  await assert.rejects(llm.complete('hi'), /could not reach .* Is the server running\?/);
});

test('cleanOutput removes reasoning and a wrapping fence only', () => {
  assert.strictEqual(cleanOutput('<think>a\nb</think>\n# Title'), '# Title');
  assert.strictEqual(cleanOutput('```md\n# T\n```'), '# T');
  assert.strictEqual(cleanOutput('# T\n\n```js\ncode\n```'), '# T\n\n```js\ncode\n```');
});

test('the default provider is the Claude CLI with the configured model', () => {
  const llm = createLlm(DEFAULT_SETTINGS);
  assert.strictEqual(llm.config.protocol, 'claude-cli');
  assert.strictEqual(llm.config.model, DEFAULT_SETTINGS.CLAUDE_MODEL);
  assert.strictEqual(llm.name, 'Claude');
});
