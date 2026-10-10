<#
.SYNOPSIS
  Builds llama.cpp with Vulkan (GPU) support and downloads a vision model, for frame_analyze.py.

.DESCRIPTION
  1. Clones llama.cpp into tools\llama.cpp and builds llama-server.exe with the Vulkan backend.
  2. Downloads Qwen2.5-VL-3B-Instruct (Q4_K_M) and its mmproj file into tools\models.

  Needs Git, CMake, the Vulkan SDK and VS Build Tools: run setup-whisper.ps1 first, which installs them.
  Safe to rerun: finished steps are skipped.

.EXAMPLE
  .\setup-llama.ps1
#>
param(
  [string]$LlamaCppTag = 'master'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'tools\llama.cpp'
$modelsDir = Join-Path $root 'tools\models'

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:VULKAN_SDK = [Environment]::GetEnvironmentVariable('VULKAN_SDK', 'Machine')
}

Refresh-Path

foreach ($tool in 'git', 'cmake') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. Open a new terminal and rerun." }
}
if (-not $env:VULKAN_SDK) { throw 'VULKAN_SDK is not set. Install the Vulkan SDK, then open a new terminal and rerun.' }

if (-not (Test-Path (Join-Path $src 'CMakeLists.txt'))) {
  Write-Host "[clone] llama.cpp $LlamaCppTag ..."
  New-Item -ItemType Directory -Force (Join-Path $root 'tools') | Out-Null
  git clone --depth 1 --branch $LlamaCppTag https://github.com/ggml-org/llama.cpp $src
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}

$server = Join-Path $src 'build\bin\Release\llama-server.exe'
if (-not (Test-Path $server)) {
  Write-Host '[build] llama.cpp with Vulkan (several minutes) ...'
  Push-Location $src
  try {
    cmake -B build -DGGML_VULKAN=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
    if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
    cmake --build build -j $env:NUMBER_OF_PROCESSORS --config Release --target llama-server
    if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }
  } finally { Pop-Location }
} else {
  Write-Host '[ok] llama-server.exe already built'
}

New-Item -ItemType Directory -Force $modelsDir | Out-Null
$files = @{
  'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf'      = 'https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf'
  'mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf' = 'https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF/resolve/main/mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf'
}
foreach ($name in $files.Keys) {
  $dest = Join-Path $modelsDir $name
  if (Test-Path $dest) { Write-Host "[ok] $name already downloaded"; continue }
  Write-Host "[model] downloading $name ..."
  Invoke-WebRequest -Uri $files[$name] -OutFile "$dest.part"
  Move-Item "$dest.part" $dest
}

Write-Host "`n[test] checking the GPU backend ..."
$log = & $server --list-devices 2>&1 | Out-String
if ($log -match 'Vulkan\d+:') { Write-Host '[ok] llama-server sees a Vulkan device' }
else { Write-Warning 'No Vulkan device reported by llama-server --list-devices. Check your GPU drivers.' }

Write-Host "`nDone. process.js runs frame_analyze.py automatically when screenshots are enabled."
