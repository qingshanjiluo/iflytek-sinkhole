# 从本机卸载:停任务、删计划任务、删防火墙规则、删本机证书条目(存储文件和证书保留)
$ErrorActionPreference = 'SilentlyContinue'
$tn = 'ifl' + 'ytek-sinkhole'
Stop-ScheduledTask  -TaskName $tn
Unregister-ScheduledTask -TaskName $tn -Confirm:$false
netsh advfirewall firewall delete rule name="Sinkhole-DNS-UDP"   | Out-Null
netsh advfirewall firewall delete rule name="Sinkhole-DNS-TCP"   | Out-Null
netsh advfirewall firewall delete rule name="Sinkhole-Web-TCP"   | Out-Null
netsh advfirewall firewall delete rule name="Sinkhole-Web-TLS"   | Out-Null
Get-CimInstance Win32_Process -Filter "Name like '%node%'" |
  Where-Object { $_.CommandLine -like '*--svc-sinkhole*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host '已卸载(文件存储 storage\ 与证书 certs\ 未删除,需要的话手动清理)' -ForegroundColor Green
