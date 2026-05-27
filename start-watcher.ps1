$ErrorActionPreference = "Stop"

$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node"
$nodeExe = Join-Path $runtimeRoot "bin\node.exe"

if (-not (Test-Path $nodeExe)) {
  $nodeExe = "node"
}

& $nodeExe (Join-Path $PSScriptRoot "watcher.js")
