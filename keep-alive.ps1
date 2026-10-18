# 保活守护:由计划任务 sinkhole-keepalive 每 5 分钟调用(纯原生命令,轻量可靠)
# v2:三种病都要治——
#   ① 0 实例:服务没了 → 重启任务
#   ② 多实例打架(端口避让把栈切开:一个占 53/80/443/28791,其余占 28792+ → 一半功能全哑)
#      → 全杀 + 重启任务,收敛成单实例(实例刚起 90s 内不动,给暖机留时间)
#   ③ 单实例但卡死(53 还在 LISTENING,事件循环却死 → 老版只看监听会永远误判"正常")
#      → 真发一个 DNS 查询探活,无应答就重启任务
$ErrorActionPreference = 'SilentlyContinue'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*--svc-sinkhole*' })
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$logF = Join-Path $PSScriptRoot 'logs\keepalive.log'

function Restart-Task($why) {
  # 先把所有残留实例收干净(任务 /end 只停任务树里的,别的来源的孤儿实例要直接杀)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*--svc-sinkhole*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  Start-Sleep 2
  schtasks /end /tn iflytek-sinkhole 2>$null | Out-Null
  Start-Sleep 1
  schtasks /run /tn iflytek-sinkhole 2>$null | Out-Null
  Add-Content -Path $logF -Value "$stamp $why → 已清实例并重启任务(旧: $(if($procs){$procs.Count}else{0}) 实例)" -Encoding UTF8
}

if ($procs.Count -eq 0) { Restart-Task '服务不在线(0 实例)'; exit 0 }

if ($procs.Count -gt 1) {
  $youngest = $procs | Sort-Object CreationDate | Select-Object -Last 1
  $ageSec = [int]((Get-Date) - $youngest.CreationDate).TotalSeconds
  if ($ageSec -gt 90) { Restart-Task "多实例打架($($procs.Count) 个,最年轻 ${ageSec}s 前起)"; exit 0 }
  exit 0   # 刚拉起在暖机(Defender 扫描期),下轮再判
}

# 单实例:真探活(不能只看 LISTENING——53 占着但事件循环卡死的老 bug 就是这么漏掉的)
$ans = Resolve-DnsName -Name iflytek.com -Server 127.0.0.1 -Type A -QuickTimeout -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $ans) {
  $ageSec = [int]((Get-Date) - $procs[0].CreationDate).TotalSeconds
  if ($ageSec -gt 90) { Restart-Task "单实例 53 无应答(事件循环卡死,${ageSec}s 前起)"; exit 0 }
}
exit 0   # 一切正常,不记日志(免膨胀)
