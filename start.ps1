# 后台启动中继服务(DNS :53 + Web :80/:443),日志见 logs/sinkhole.log
$ErrorActionPreference = 'Stop'
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
$existing = Get-CimInstance Win32_Process -Filter "Name like '%node%'" |
  Where-Object { $_.CommandLine -like '*--svc-sinkhole*' }
if ($existing) { Write-Host "已在运行 (PID: $($existing.ProcessId -join ', ')),先运行 stop.ps1" ; exit 0 }
$p = Start-Process -FilePath $node -ArgumentList '"index.js"','--svc-sinkhole' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2
if (-not $p.HasExited) { Write-Host "启动成功,PID $($p.ProcessId)。日志: $PSScriptRoot\logs\sinkhole.log" -ForegroundColor Green }
else { Write-Host "启动失败,请前台运行排查: node index.js" -ForegroundColor Red }
