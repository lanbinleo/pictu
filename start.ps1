$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$binaryDir = Join-Path $root 'bin'
$binaryPath = Join-Path $binaryDir 'pictu.exe'
$backendPort = 8080

function Assert-PortFree {
  param([int]$Port)

  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $label = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($listener.OwningProcess)" }
    throw "端口 $Port 已被 $label 占用。PicTu 启动脚本不会结束它，请先手动处理占用或改用别的端口。"
  }
}

Assert-PortFree -Port $backendPort

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
