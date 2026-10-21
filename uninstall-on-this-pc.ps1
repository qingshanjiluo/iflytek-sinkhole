# 从本机卸载(命令行版;图形界面用 卸载中继站.exe = 本脚本的 uninstall-gui 同款动作)
# v2 补洞(审查发现):
#   ① 旧版只删 iflytek-sinkhole → sinkhole-keepalive 每 5 分钟把已删服务复活(实证 10-17/18 两条日志)
#      现在删 3 个任务: iflytek-sinkhole / sinkhole-hotspot / sinkhole-keepalive
#   ② 旧版不停热点 → 现在 netsh wlan stop hostednetwork
#   ③ 旧版漏杀避让到 28792+ 的残留实例(CIM 过滤已覆盖,列出并停)
#   ④ 证书存储条目清理改为可选(-RemoveCert;设备上装的信任证书不动)
# 文件(storage\certs\config)一律保留;路由器 DNS 曾指向本机要手动改回。
param([switch]$StopHotspot = $true, [switch]$RemoveCert)
$ErrorActionPreference = 'SilentlyContinue'
$tn = 'ifl' + 'ytek-sinkhole'
foreach ($t in @($tn, 'sinkhole-hotspot', 'sinkhole-keepalive')) {
  if (Get-ScheduledTask -TaskName $t -EA SilentlyContinue) {
    Stop-ScheduledTask -TaskName $t
    Unregister-ScheduledTask -TaskName $t -Confirm:$false
    Write-Host "已删计划任务: $t" -ForegroundColor Green
  } else { Write-Host "计划任务不存在(跳过): $t" -ForegroundColor DarkGray }
}
netsh advfirewall firewall delete rule name="Sinkhole-DNS-UDP"   | Out-Null
netsh advfirewall firewall delete rule name="Sinkhole-DNS-TCP"   | Out-Null
netsh advfirewall firewall delete rule name="Sinkhole-Web-TCP"   | Out-Null
netsh advfirewall firewall delete rule name="Sinkhole-Web-TLS"   | Out-Null
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*--svc-sinkhole*' })
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force; Write-Host "已停服务 pid $($p.ProcessId)" -ForegroundColor Green }
if ($StopHotspot) {
  $hs = netsh wlan show hostednetwork 2>&1 | Out-String
  if ($hs -match 'Status\s*:\s*Started') { netsh wlan stop hostednetwork; Write-Host '热点广播已停止' -ForegroundColor Green }
}
if ($RemoveCert) {
  Get-ChildItem "Cert:\CurrentUser\My" | Where-Object { $_.FriendlyName -like 'sinkhole-*' } | Remove-Item -Force
  Write-Host '本机证书存储 sinkhole-* 条目已清理' -ForegroundColor Green
}
Write-Host '已卸载(文件 storage\ 与证书 certs\ 未删除,需要的话手动清理)' -ForegroundColor Green
Write-Host '注意: 路由器/光猫 DHCP 若曾把 DNS 指向本机,请改回原值,否则设备断网!' -ForegroundColor Yellow
