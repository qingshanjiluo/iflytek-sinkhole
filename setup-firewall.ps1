# 放行局域网对本机 53/80/443 的入站访问(需以管理员身份运行)
$ErrorActionPreference = 'Stop'
$rules = @(
  @{ Name = 'Sinkhole-DNS-UDP'; Protocol = 'UDP'; Port = 53 },
  @{ Name = 'Sinkhole-DNS-TCP'; Protocol = 'TCP'; Port = 53 },
  @{ Name = 'Sinkhole-Web-TCP'; Protocol = 'TCP'; Port = 80 },
  @{ Name = 'Sinkhole-Web-TLS'; Protocol = 'TCP'; Port = 443 }
)
foreach ($r in $rules) {
  $existing = netsh advfirewall firewall show rule name=$($r.Name) | Select-String -SimpleMatch $r.Name
  if ($existing) { Write-Host "规则已存在,收紧远程范围: $($r.Name)" }
  else {
    netsh advfirewall firewall add rule name="$($r.Name)" dir=in action=allow protocol=$($r.Protocol) localport=$($r.Port) profile=any | Out-Null
    Write-Host "已添加: $($r.Name) ($($r.Protocol) $($r.Port))" -ForegroundColor Green
  }
  # 只允许本地子网访问(回环流量不经防火墙,本机自测不受影响)
  netsh advfirewall firewall set rule name="$($r.Name)" new remoteip=LocalSubnet | Out-Null
}
