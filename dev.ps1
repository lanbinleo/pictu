$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$backend = $null
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

try {
  Assert-PortFree -Port $backendPort

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
