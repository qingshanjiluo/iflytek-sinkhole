# 保活守护:每 5 分钟检查 sinkhole 是否在监听;不在就自动拉起
# 由计划任务 sinkhole-keepalive 每 5 分钟调用一次(纯原生命令,轻量可靠)
$ErrorActionPreference = 'SilentlyContinue'
$listening = netstat -ano | Select-String ':53 .*LISTENING'
if (-not $listening) {
  try {
    schtasks /run /tn iflytek-sinkhole | Out-Null
    Add-Content -Path (Join-Path $PSScriptRoot 'logs\keepalive.log') -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 服务不在线,已重新拉起" -Encoding UTF8
  } catch {
    Add-Content -Path (Join-Path $PSScriptRoot 'logs\keepalive.log') -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 拉起失败: $_" -Encoding UTF8
  }
}
