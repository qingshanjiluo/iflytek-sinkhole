# 停止中继服务(匹配 --svc-sinkhole 标记,不依赖文件夹名)
$procs = Get-CimInstance Win32_Process -Filter "Name like '%node%'" |
  Where-Object { $_.CommandLine -like '*--svc-sinkhole*' }
if ($procs) {
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "已停止 PID $($_.ProcessId)" -ForegroundColor Yellow }
} else { Write-Host "没有在运行的实例" }
