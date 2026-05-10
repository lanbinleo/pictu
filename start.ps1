$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$binaryDir = Join-Path $root 'bin'
$binaryPath = Join-Path $binaryDir 'pictu.exe'
$backendPort = 8080

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

Stop-ListeningPort -Port $backendPort

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
