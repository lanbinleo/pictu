$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$backend = $null
$backendPort = 8080
$frontendPort = 5173

function Stop-ListeningPort {
  param([int]$Port)

  $pids = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pid in $pids) {
    if (-not $pid) { continue }
    $owner = Get-Process -Id $pid -ErrorAction SilentlyContinue
    $label = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $pid" }
    Write-Host "停止占用端口 $Port 的进程：$label"
    Stop-Process -Id $pid -Force -ErrorAction Stop
  }
}

try {
  Stop-ListeningPort -Port $backendPort
  Stop-ListeningPort -Port $frontendPort

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
