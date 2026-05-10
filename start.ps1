$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$binaryDir = Join-Path $root 'bin'
$binaryPath = Join-Path $binaryDir 'pictu.exe'

if (-not (Test-Path (Join-Path $webDir 'node_modules'))) {
  Push-Location $webDir
  try {
    npm install
  } finally {
    Pop-Location
  }
}

Push-Location $webDir
try {
  npm run build
} finally {
  Pop-Location
}

if (-not (Test-Path $binaryDir)) {
  New-Item -ItemType Directory -Path $binaryDir | Out-Null
}

Push-Location $serverDir
try {
  go build -o $binaryPath .\cmd\pictu
} finally {
  Pop-Location
}

Push-Location $root
try {
  & $binaryPath
} finally {
  Pop-Location
}
