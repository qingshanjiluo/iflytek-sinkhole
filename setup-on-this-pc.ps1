# =====================================================================
#  一键部署本中继套件 —— 在任何一台 Windows 电脑上运行(以管理员身份):
#    整个文件夹拷到新电脑 → 管理员 PowerShell →
#    Set-Location 到本目录 → .\setup-on-this-pc.ps1
#  可选参数:
#    -BundleRuntime  系统没有 Node 时:自动下载便携版 Node 到 runtime\
#    -SkipHotspot    不开热点(只想做 DNS+中继站,设备走路由器 DNS 指向本机)
#  流程:环境自检 → 补齐缺项(Node/证书/防火墙) → 注册开机自启 → 启动服务 → 启动热点 → 报告
# =====================================================================
param([switch]$BundleRuntime, [switch]$SkipHotspot)
$ErrorActionPreference = 'Stop'
function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  [X]  $t" -ForegroundColor Red }

# ---------- 0) 管理员权限 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail '需要管理员权限:右键 PowerShell →「以管理员身份运行」后重试'; exit 1 }

# ---------- 1) 环境自检 ----------
Step 1 '环境自检'
$need = @('index.js','config.json','dns-server.js','relay-site.js','web-proxy.js','dhcp-server.js','hotspot.ps1','register-autostart.ps1','make-cert.ps1','setup-firewall.ps1','public\index.html','public\login.html')
$missing = $need | Where-Object { -not (Test-Path (Join-Path $PSScriptRoot $_)) }
if ($missing) { Fail "部署包不完整,缺: $($missing -join ', ')  —— 请整夹拷贝,别漏文件"; exit 1 }
OK '部署包文件完整'

$node = $null
$rtNode = Join-Path $PSScriptRoot 'runtime\node.exe'
if (Test-Path $rtNode) { $node = $rtNode; OK "自带运行时 runtime\node.exe" }
else { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source; OK "系统 Node: $node" } else { Warn '未找到 Node(下一步处理)' } }

# 端口占用提示:53/80 被占是谁的
foreach ($pt in 53, 80) {
  $own = netstat -ano | Select-String ":$pt\s+.*LISTENING" | ForEach-Object { ($_.Line.Trim() -split '\s+')[-1] } | Select-Object -First 1
  if ($own) {
    $pn = (Get-Process -Id $own -ErrorAction SilentlyContinue).ProcessName
    Warn "端口 $pt 已被占用: PID $own ($pn) —— 若是本服务旧实例无妨(下面会重启)"
  } else { OK "端口 $pt 空闲" }
}

$wlan = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Wi-?Fi|Wireless|WLAN|802\.11|AX[0-9]' -or $_.Name -match 'WLAN|Wi-?Fi' } | Select-Object -First 1
if ($wlan) { OK "无线网卡: $($wlan.Name) / $($wlan.InterfaceDescription)" } else { Warn '未检测到无线网卡 —— 将跳过热点(设备可改用路由器 DNS 指向本机)' }
if ($wlan) {
  $drv = netsh wlan show drivers | Out-String
  if ($drv -match '(?m)^\s+Hosted network supported\s*:\s*Yes') { OK '网卡支持热点(HostedNetwork)' }
  else { Warn '该网卡不支持 hostednetwork 热点,跳过热点步骤' }
}
if (-not (Test-Path (Join-Path $PSScriptRoot 'home-wifi-profile.xml'))) { Warn '缺 home-wifi-profile.xml:热点信道可能落在 5GHz,2.4G 学习机搜不到' }

# ---------- 2) Node 运行时(缺则下载便携版) ----------
Step 2 'Node 运行时'
if (-not $node) {
  if (-not $BundleRuntime) { Fail '没有 Node。重跑: .\setup-on-this-pc.ps1 -BundleRuntime (自动下载约30MB便携版)'; exit 1 }
  $ver = 'v20.18.1'
  $url = "https://registry.npmmirror.com/-/binary/node/$ver/node-$ver-win-x64.zip"
  $zip = Join-Path $env:TEMP 'node-portable.zip'; $ext = Join-Path $env:TEMP 'node-portable-ext'
  Write-Host "  下载 Node 便携版 $ver (npmmirror 国内源)..." -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $ext -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'runtime') | Out-Null
  Copy-Item (Join-Path $ext "node-$ver-win-x64\node.exe") $rtNode -Force
  Remove-Item $zip, $ext -Recurse -Force -ErrorAction SilentlyContinue
  $node = $rtNode
  OK 'runtime\node.exe 就绪(此后此文件夹在任何电脑免装 Node)'
} else { OK "Node 就绪: $node" }

# ---------- 3) 证书(每机一份,自签;客户端信任仍用 certs\iflytek.cer) ----------
Step 3 '自签证书'
if (-not (Test-Path (Join-Path $PSScriptRoot 'certs\iflytek.pfx'))) {
  & (Join-Path $PSScriptRoot 'make-cert.ps1')
  OK '证书已生成'
} else { OK '证书已存在,跳过' }

# ---------- 4) 防火墙(仅局域网可访问 53/80/443/67) ----------
Step 4 '防火墙规则'
& (Join-Path $PSScriptRoot 'setup-firewall.ps1')
OK '防火墙规则就绪'

# ---------- 5) 注册开机自启(服务 + 热点 + 5分钟保活) + 立即启动服务 ----------
Step 5 '注册计划任务并启动服务'
& (Join-Path $PSScriptRoot 'register-autostart.ps1')
schtasks /end /tn iflytek-sinkhole 2>$null | Out-Null
Start-Sleep 2
schtasks /run /tn iflytek-sinkhole | Out-Null
OK '服务任务已触发(开机也自动)'

# ---------- 6) 等待服务就绪(Defender 首次冷扫 98MB node 可能 5-8 分钟,保活任务会持续兜底) ----------
Step 6 '等待服务就绪(轮询 http://127.0.0.1/,最多 90 秒)'
$ready = $false
for ($i = 1; $i -le 15; $i++) {
  Start-Sleep 6
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1/api/info' -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
}
if ($ready) { OK "服务已就绪(第 $([int](6*$i)) 秒)" }
else { Warn '90 秒内未就绪 —— 大概率是 Defender 首次扫描本机 node.exe(最长约8分钟),5 分钟保活任务会自动重试,稍后浏览器开 http://iflytek.com 即可' }

# ---------- 7) 启动热点 ----------
$hot = '未启动'
if ($SkipHotspot) { $hot = '已按 -SkipHotspot 跳过' }
elseif (-not $wlan) { $hot = '无无线网卡,跳过' }
else {
  Step 7 '启动热点(hostednetwork + 内置 DHCP)'
  try { & (Join-Path $PSScriptRoot 'hotspot.ps1') } catch { Warn "hotspot.ps1 异常: $($_.Exception.Message)" }
  $hs = netsh wlan show hostednetwork | Out-String
  if ($hs -match 'Status\s*:\s*Started') {
    $ssid = ([regex]::Match($hs, 'SSID name\s+:\s+"([^"]+)"')).Groups[1].Value
    $ch   = ([regex]::Match($hs, 'Channel\s+:\s+(\d+)')).Groups[1].Value
    $hot  = "运行中 ($ssid, 信道 $ch)"
    OK "热点: $ssid / 信道 $ch"
  } else { $hot = '启动失败(查看上面 hotspot.ps1 提示)'; Warn '热点未启动,重跑 .\hotspot.ps1;仍失败拔插网卡再试' }
}

# ---------- 8) 部署完成报告 ----------
Step 8 '部署完成,记下这些'
Write-Host ''
Write-Host '  本机 IP(把设备 DNS / 光猫 DHCP 下发指向它):' -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback|Bluetooth' } |
  ForEach-Object { Write-Host ("    {0,-16} [{1}]" -f $_.IPAddress, $_.InterfaceAlias) -ForegroundColor White }
$auth = $null
try { $auth = (Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).relay.auth } catch {}
Write-Host ''
Write-Host "  服务: $((if ($ready) {'运行中'} else {'启动中(保活兜底)'}))  |  热点: $hot" -ForegroundColor Cyan
if ($auth -and $auth.enabled) {
  $u = @($auth.accounts.PSObject.Properties.Name)[0]
  Write-Host "  登录: 账号 $u / 密码(见 config.json relay.auth.accounts) —— 新电脑部署后建议立即改密码" -ForegroundColor Yellow
}
Write-Host '  入口: 设备连热点或把 DNS 指向上面 IP → 浏览器 http://iflytek.com → 登录 → 中继站' -ForegroundColor Cyan
Write-Host '  本机: 双击桌面「中继站(管理员)」快捷方式(免登录直入)' -ForegroundColor Cyan
Write-Host ''
