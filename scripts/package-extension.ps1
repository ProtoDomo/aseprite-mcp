param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutputDir = (Join-Path $RepoRoot 'dist')
)

$ErrorActionPreference = 'Stop'

$extensionRoot = Join-Path $RepoRoot 'extension\aseprite-codex-bridge'
$packageJson = Join-Path $extensionRoot 'package.json'
$scriptFile = Join-Path $extensionRoot 'codex-bridge.lua'

if (-not (Test-Path -LiteralPath $packageJson)) {
  throw "Missing extension package.json at $packageJson"
}
if (-not (Test-Path -LiteralPath $scriptFile)) {
  throw "Missing extension Lua script at $scriptFile"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$zipPath = Join-Path $OutputDir 'aseprite-codex-bridge.zip'
$extensionPath = Join-Path $OutputDir 'aseprite-codex-bridge.aseprite-extension'
Remove-Item -LiteralPath $zipPath, $extensionPath -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $extensionRoot '*') -DestinationPath $zipPath -Force
Move-Item -LiteralPath $zipPath -Destination $extensionPath

Write-Output $extensionPath
