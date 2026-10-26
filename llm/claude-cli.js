// Claude through the logged-in `claude` CLI (the pipeline's original and default backend).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const EXEC_OPTS = { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 };

function create(config) {
  return {
    // The prompt goes through a temp file + stdin redirect (async exec has no `input`
    // option). Images are passed as paths that the CLI reads with its Read tool.
    async complete(prompt, { images = [] } = {}) {
      let extraArgs = '';
      if (images.length > 0) {
        const dirs = [...new Set(images.map(p => path.dirname(p)))];
        extraArgs = `${dirs.map(d => `--add-dir "${d}"`).join(' ')} --allowedTools Read`;
        prompt = `Look at the image${images.length > 1 ? 's' : ''} at ${images.length > 1 ? 'these paths' : 'this path'}: ${images.join(', ')}\n\n${prompt}`;
      }
      const tmpFile = path.join(os.tmpdir(), `claude-prompt-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpFile, prompt, 'utf-8');
      try {
        const { stdout } = await execAsync(`claude -p --model ${config.model} ${extraArgs} < "${tmpFile}"`, EXEC_OPTS);
        return stdout.trim();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    },
    // The CLI has no model listing; these are the aliases and current IDs it accepts.
    async listModels() {
      return ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'haiku', 'sonnet', 'opus'].map(id => ({ id }));
    },
  };
}

module.exports = { create };
