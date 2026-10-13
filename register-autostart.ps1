# 注册开机自启计划任务(需以管理员身份运行);卸载见 README / uninstall-on-this-pc.ps1
$ErrorActionPreference = 'Stop'
# 自带运行时优先,其次系统 PATH —— 整个文件夹拷到任何电脑都能用
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { Write-Host '缺少 Node:请运行 .\setup-on-this-pc.ps1 -BundleRuntime' -ForegroundColor Red; exit 1 }
  $node = $cmd.Source
}
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$PSScriptRoot\index.js`" --svc-sinkhole" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'   # 晚于系统服务(含ICS移动热点的53端口代理)绑定,确保本服务抢到 53
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'iflytek-sinkhole' -Action $action -Trigger $trigger -Settings $set -Principal $principal -Force | Out-Null
Write-Host "已注册开机自启任务 iflytek-sinkhole (SYSTEM, 开机30秒后自启)" -ForegroundColor Green
# 热点任务:开机 1 分钟后自动开热点(连家里 2.4G → hostednetwork 信道跟随,SSID/密码在 hotspot.ps1)
$hotTr = 'powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'hotspot.ps1') + '"'
schtasks /create /tn sinkhole-hotspot /tr $hotTr /sc onstart /delay 0001:00 /ru SYSTEM /rl HIGHEST /f | Out-Null
Write-Host '已注册热点任务 sinkhole-hotspot (开机1分钟后自启)' -ForegroundColor Green
# 保活任务:每 5 分钟探 53 端口,服务被 Defender 挂死/误杀时自动拉起
$kaTr = 'powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'keep-alive.ps1') + '"'
schtasks /create /tn sinkhole-keepalive /tr $kaTr /sc minute /mo 5 /ru SYSTEM /rl HIGHEST /f | Out-Null
Write-Host '已注册保活任务 sinkhole-keepalive (每5分钟)' -ForegroundColor Green
Write-Host "立即启动服务: Start-ScheduledTask -TaskName iflytek-sinkhole"
