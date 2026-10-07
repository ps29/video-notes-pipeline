<#
.SYNOPSIS
  Builds whisper.cpp with Vulkan (GPU) support and downloads a model, for transcribe.py.

.DESCRIPTION
  1. Installs missing build tools via winget: CMake, Vulkan SDK, Visual Studio 2022 Build Tools (C++).
  2. Clones whisper.cpp into tools\whisper.cpp.
  3. Builds whisper-cli.exe with the Vulkan backend.
  4. Downloads a ggml model.

  Safe to rerun: finished steps are skipped. The Visual Studio Build Tools install is large
  (~6 GB) and the Vulkan SDK / VS installers ask for administrator approval.

.EXAMPLE
  .\setup-whisper.ps1                      # small.en model
  .\setup-whisper.ps1 -Model medium.en     # more accurate, slower
  .\setup-whisper.ps1 -SkipInstall         # tools already installed
#>
param(
  [string]$Model = 'small.en',
  [string]$WhisperCppTag = 'v1.9.5',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'tools\whisper.cpp'

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:VULKAN_SDK = [Environment]::GetEnvironmentVariable('VULKAN_SDK', 'Machine')
}

function Test-BuildTools {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { return $false }
  $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return [bool]$found
}

function Install-IfMissing($name, $present, $wingetArgs) {
  if ($present) { Write-Host "[ok] $name already installed"; return }
  Write-Host "[install] $name ..."
  winget install -e --accept-package-agreements --accept-source-agreements @wingetArgs
  if ($LASTEXITCODE -ne 0) { throw "winget failed installing $name (exit $LASTEXITCODE)" }
}

Refresh-Path

if (-not $SkipInstall) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget not found. Install the tools manually (see README) and rerun with -SkipInstall.' }
  Install-IfMissing 'Git' ([bool](Get-Command git -ErrorAction SilentlyContinue)) @('--id', 'Git.Git')
  Install-IfMissing 'CMake' ([bool](Get-Command cmake -ErrorAction SilentlyContinue)) @('--id', 'Kitware.CMake')
  Install-IfMissing 'Vulkan SDK' ([bool]([Environment]::GetEnvironmentVariable('VULKAN_SDK', 'Machine'))) @('--id', 'KhronosGroup.VulkanSDK')
  Install-IfMissing 'Visual Studio 2022 Build Tools (C++)' (Test-BuildTools) @(
    '--id', 'Microsoft.VisualStudio.2022.BuildTools',
    '--override', '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
  Refresh-Path
}

foreach ($tool in 'git', 'cmake') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH. Open a new terminal and rerun." }
}
if (-not $env:VULKAN_SDK) { throw 'VULKAN_SDK is not set. Install the Vulkan SDK, then open a new terminal and rerun.' }

if (-not (Test-Path (Join-Path $src 'CMakeLists.txt'))) {
  Write-Host "[clone] whisper.cpp $WhisperCppTag ..."
  New-Item -ItemType Directory -Force (Join-Path $root 'tools') | Out-Null
  git clone --depth 1 --branch $WhisperCppTag https://github.com/ggml-org/whisper.cpp $src
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}

$cli = Join-Path $src 'build\bin\Release\whisper-cli.exe'
if (-not (Test-Path $cli)) {
  Write-Host '[build] whisper.cpp with Vulkan (a few minutes) ...'
  Push-Location $src
  try {
    cmake -B build -DGGML_VULKAN=1 -DCMAKE_BUILD_TYPE=Release
    if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
    cmake --build build -j $env:NUMBER_OF_PROCESSORS --config Release --target whisper-cli
    if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }
  } finally { Pop-Location }
} else {
  Write-Host '[ok] whisper-cli.exe already built'
}

$modelFile = Join-Path $src "models\ggml-$Model.bin"
if (-not (Test-Path $modelFile)) {
  Write-Host "[model] downloading ggml-$Model ..."
  $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
  Invoke-WebRequest -Uri $url -OutFile "$modelFile.part"
  Move-Item "$modelFile.part" $modelFile
} else {
  Write-Host "[ok] model ggml-$Model already downloaded"
}

Write-Host "`n[test] checking the GPU backend ..."
$sample = Join-Path $src 'samples\jfk.wav'
$log = & $cli -m $modelFile -f $sample -nt 2>&1 | Out-String
if ($log -match 'using Vulkan\d* backend') { Write-Host '[ok] whisper.cpp is using the Vulkan GPU backend' }
else { Write-Warning 'Built, but the Vulkan GPU backend was not used (it fell back to CPU). Check your GPU drivers.' }

Write-Host "`nDone. transcribe.py picks up whisper.cpp automatically (it uses the most accurate model found in tools\whisper.cpp\models)."
