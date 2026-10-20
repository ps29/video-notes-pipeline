// electron-builder configuration (npm run dist).
//
// The app ships the GUI plus a copy of the pipeline (resources/pipeline), which gui/main.js
// copies to %LOCALAPPDATA%\VideoNotes\pipeline on first start when no pipeline folder was
// chosen. The pipeline's runtime node_modules (the Anthropic SDK and its dependencies) go with it.
const { execSync } = require('child_process');
const path = require('path');

// Production dependency folders, relative to node_modules (e.g. "@anthropic-ai/sdk").
function productionDependencies() {
  let out;
  try {
    out = execSync('npm ls --omit=dev --all --parseable', { cwd: __dirname, encoding: 'utf-8' });
  } catch (err) {
    out = err.stdout || ''; // npm ls exits non-zero on extraneous packages; the list is still printed
  }
  const modules = path.join(__dirname, 'node_modules');
  return out.split(/\r?\n/).filter(Boolean)
    .map(p => path.relative(modules, p))
    .filter(p => p && !p.startsWith('..') && !path.isAbsolute(p))
    .map(p => p.split(path.sep).join('/'));
}

module.exports = {
  appId: 'com.praveshshrestha.videonotes',
  productName: 'Video Notes',
  directories: { output: 'dist' },
  files: ['gui/**', 'package.json'],
  extraResources: [
    {
      from: '.',
      to: 'pipeline',
      filter: [
        'process.js', 'deps-check.js', 'llm/**',
        'transcribe.py', 'frame_analyze.py', 'setup-whisper.ps1', 'setup-llama.ps1',
        'pyproject.toml', 'uv.lock',
      ],
    },
    {
      from: 'node_modules',
      to: 'pipeline/node_modules',
      filter: productionDependencies().map(dep => `${dep}/**`),
    },
  ],
  win: { target: ['nsis', 'portable'] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Video Notes',
    artifactName: 'VideoNotes-Setup-${version}.${ext}',
    include: 'build/installer.nsh',
  },
  portable: { artifactName: 'VideoNotes-Portable-${version}.${ext}' },
};
