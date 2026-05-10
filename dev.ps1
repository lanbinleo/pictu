$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$backend = $null

try {
  if (-not (Test-Path (Join-Path $webDir 'node_modules'))) {
    Push-Location $webDir
    try {
      npm install
    } finally {
      Pop-Location
    }
  }

  $backend = Start-Process go -WindowStyle Hidden -PassThru -WorkingDirectory $serverDir -ArgumentList @('run', '.\cmd\pictu')

  Push-Location $webDir
  try {
    npm run dev
  } finally {
    Pop-Location
  }
}
finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force
  }
}
