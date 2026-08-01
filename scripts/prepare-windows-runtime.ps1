$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'src-tauri\resources\bin\windows'
$appRuntimeDir = Join-Path $projectRoot 'src-tauri\resources\app-runtime'
$nodeSource = (Get-Command node -ErrorAction Stop).Source
$ffmpegSource = $env:OMNI_FFMPEG_PATH

if (-not $ffmpegSource) {
  $systemFfmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($systemFfmpeg) {
    $ffmpegSource = $systemFfmpeg.Source
  }
}

if (-not $ffmpegSource) {
  throw 'No FFmpeg executable found. Install a redistributable GPL build on PATH or set OMNI_FFMPEG_PATH.'
}

if (-not (Test-Path $ffmpegSource)) {
  throw "FFmpeg executable not found: $ffmpegSource"
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item -Force $nodeSource (Join-Path $runtimeDir 'node.exe')
Copy-Item -Force $ffmpegSource (Join-Path $runtimeDir 'ffmpeg.exe')

& npm ci --prefix $appRuntimeDir --omit=dev
if ($LASTEXITCODE -ne 0) {
  throw 'Failed to install the packaged application runtime dependencies.'
}

$ffmpegTarget = Join-Path $runtimeDir 'ffmpeg.exe'
$version = & $ffmpegTarget -version 2>&1 | Out-String
$encoders = & $ffmpegTarget -hide_banner -encoders 2>&1 | Out-String

if ($version -match '--enable-nonfree') {
  throw 'The selected FFmpeg build contains --enable-nonfree. Set OMNI_FFMPEG_PATH to a redistributable GPL build and retry.'
}

if ($encoders -notmatch 'libx264') {
  throw 'The selected FFmpeg build does not provide libx264.'
}

if ($encoders -notmatch '\spng\s') {
  throw 'The selected FFmpeg build does not provide the PNG encoder.'
}

Write-Host "Prepared Windows runtime: $runtimeDir"
Write-Host "Node: $(& (Join-Path $runtimeDir 'node.exe') --version)"
Write-Host (($version -split "`r?`n")[0])
