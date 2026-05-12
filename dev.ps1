$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$webDir = Join-Path $root 'web'
$serverDir = Join-Path $root 'server'
$binaryDir = Join-Path $root 'bin'
$backendBin = Join-Path $binaryDir 'pictu-dev.exe'
$backend = $null
$backendPort = 8080
$frontendPort = 5173

function Stop-ListeningPort {
  param([int]$Port)

  $pids = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pider in $pids) {
    if (-not $pider) { continue }
    $owner = Get-Process -Id $pider -ErrorAction SilentlyContinue
    $label = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $pider" }
    Write-Host "停止占用端口 $Port 的进程：$label"
    Stop-Process -Id $pider -Force -ErrorAction Stop
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

  if (-not (Test-Path $binaryDir)) {
    New-Item -ItemType Directory -Path $binaryDir | Out-Null
  }

  $air = Get-Command air -ErrorAction SilentlyContinue
  if ($air) {
    Write-Host '启动后端：air 热重载'
    $backend = Start-Process $air.Source -WindowStyle Hidden -PassThru -WorkingDirectory $serverDir -ArgumentList @(
      '--build.cmd',
      "go build -o `"$backendBin`" .\cmd\pictu",
      '--build.entrypoint',
      $backendBin
    )
  } else {
    Write-Warning '未找到 air，后端将使用 go run；Go 代码变更后需要重启 dev.ps1。安装：go install github.com/air-verse/air@latest'
    $backend = Start-Process go -WindowStyle Hidden -PassThru -WorkingDirectory $serverDir -ArgumentList @('run', '.\cmd\pictu')
  }

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
  Stop-ListeningPort -Port $backendPort
  Stop-ListeningPort -Port $frontendPort
}
