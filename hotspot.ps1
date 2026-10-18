# =====================================================================
#  经典 SoftAP 热点(伪装普通 WiFi):AIC/常规无线网卡免配置开热点
#  用法(管理员 PowerShell):
#    .\hotspot.ps1                      启动热点(SSID/密码/网卡读 config.json relay.hotspot)
#    .\hotspot.ps1 -Stop                关闭热点
#    .\hotspot.ps1 -Ssid MyWiFi -Key 12345678   手动指定(优先于 config)
#    .\hotspot.ps1 -Nic 'WLAN(USB)'     指定无线网卡名(内置/USB 任选;优先于 config 的 nic)
#  说明:
#  - WPA2-Personal/CCMP,与普通路由器空口协议一致,无"手机热点"特征
#  - Windows 部分内置"移动热点"页面打不开时的可靠替代(经典 hostednetwork)
#  - 自动挂 ICS:出口=当前有默认路由的网卡,热点口拿 192.168.137.1 发 DHCP
#  - 若学习机/老设备搜不到:多为 AP 被驱动定在 5GHz 信道,让本机 WLAN 先连
#    家里 2.4G WiFi(hostednetwork 会跟随 STA 信道)或换 2.4G 档位的网卡
# =====================================================================
param(
  [string]$Ssid = '',
  [string]$Key  = '',
  [string]$Nic  = '',
  [switch]$Stop
)
$ErrorActionPreference = 'Continue'

# 优先级: 传参 > config.json relay.hotspot.{ssid,key,nic} > 内置默认(安装向导/管理器写 config,这里自动跟随)
if (-not $Ssid -or -not $Key -or -not $Nic) {
  try {
    $cfg = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'config.json'), (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
    $hs = $null
    if ($cfg.relay) { $hs = $cfg.relay.hotspot }
    if (-not $Ssid) { if ($hs -and $hs.ssid) { $Ssid = $hs.ssid } else { $Ssid = 'China_Unicom' } }
    if (-not $Key)  { if ($hs -and $hs.key)  { $Key  = $hs.key }  else { $Key  = 'unicom2026' } }
    if (-not $Nic)  { if ($hs -and $hs.nic)  { $Nic  = $hs.nic } }
  } catch {
    if (-not $Ssid) { $Ssid = 'China_Unicom' }
    if (-not $Key)  { $Key = 'unicom2026' }
  }
}

if ($Stop) {
  netsh wlan stop hostednetwork
  Write-Host '热点已关闭' -ForegroundColor Yellow
  exit 0
}

# 1) 无线网卡与承载网络
#    指定了 -Nic 就按名字精确选;否则按描述自动挑第一张无线卡。
#    虚拟卡(Hyper-V vEthernet / Wi-Fi Direct / HostedNetwork 虚拟AP)一律排除——
#    它们不能承载热点;老 config 里的毒值 nic="vEthernet (WLAN)" 就在这里被拦下回退自动挑卡。
if ($Nic) {
  $wlan = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $Nic } | Select-Object -First 1
  if ($wlan) {
    $dsc = [string]$wlan.InterfaceDescription; $nm = [string]$wlan.Name
    if ($dsc -match 'Wi-Fi Direct|Hosted Network|Hyper-V|Virtual Switch|WAN Miniport' -or $nm -match '^vEthernet|^本地连接\*') {
      Write-Host "网卡「$Nic」是虚拟卡($dsc),不能开热点 → 改用真实无线网卡" -ForegroundColor Yellow
      $wlan = $null; $Nic = ''
    }
  } else {
    Write-Host "找不到名为「$Nic」的网卡,改用自动选择" -ForegroundColor Yellow
    $Nic = ''
  }
}
if (-not $wlan) {
  # 自动挑卡同样剔虚拟卡(名称撞 WLAN 的 vEthernet (WLAN) 就是这么混进来的)
  $wlan = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Status -ne 'Disabled' -and
      $_.Name -notmatch '^vEthernet|^本地连接\*' -and
      $_.InterfaceDescription -notmatch 'Wi-Fi Direct|Hosted Network|Hyper-V|Virtual Switch|WAN Miniport' -and
      ($_.InterfaceDescription -match 'Wi-?Fi|Wireless|WLAN|802\.11|Wireless-AC|AX[0-9]|AX\d+' -or $_.Name -match '^(WLAN|Wi-?Fi)')
    } | Select-Object -First 1
}
if (-not $wlan) { Write-Host '未找到无线网卡(USB 网卡插好了吗?驱动装了吗?)' -ForegroundColor Red; exit 1 }
Write-Host "使用无线网卡: $($wlan.Name) [$($wlan.InterfaceDescription)]" -ForegroundColor Cyan
# 驱动承载网络支持:只在**明确读到 No** 时才硬失败;
# netsh 输出被隐藏/重定向进程吞掉时(实测存在这种坑)先照常试,让 netsh start 自己报错——绝不误杀好卡
$drv = (& netsh wlan show drivers 2>&1 | Out-String)
$mSup = [regex]::Match($drv, 'Hosted network supported\s*:\s*(\S+)')
if ($mSup.Success -and $mSup.Groups[1].Value -notmatch '^Y') {
  Write-Host "该网卡驱动不支持承载网络($($mSup.Value.Trim())),无法用经典SoftAP方式。" -ForegroundColor Red
  Write-Host '可改用系统「设置→移动热点」;或换成支持 AP 模式的网卡(管理器里重新选卡)。'
  exit 1
}
if (-not $mSup.Success) {
  Write-Host '没读到 Hosted network supported 行(netsh 输出被吞),先照常尝试;真不支持则 netsh 启动会自己报错' -ForegroundColor Yellow
}

# 1.5) STA 先连家里 2.4G WiFi(新卡已支持)→ hostednetwork 信道自动跟随,学习机(2.4G-only)才能搜到
$homeSsid = 'CU_2kyA'
# 新电脑没有家里 WiFi 配置文件时,用部署包自带的 home-wifi-profile.xml 自动导入(免手输密码)
if (-not ((netsh wlan show profiles) -match [regex]::Escape($homeSsid))) {
  $xp = Join-Path $PSScriptRoot 'home-wifi-profile.xml'
  if (Test-Path $xp) { netsh wlan add profile filename="$xp" user=all 2>$null | Out-Null }
}
$staOk = $false
$staInfo = netsh wlan show interfaces | Out-String
if ($staInfo -match 'SSID\s+:\s+' + [regex]::Escape($homeSsid) -and $staInfo -match 'State\s+:\s+connected') {
  $staOk = $true
} else {
  netsh wlan connect name="$homeSsid" interface='WLAN' 2>$null | Out-Null
  for ($i = 0; $i -lt 4; $i++) {                    # 最多等 20s(有线在线,不阻塞太久)
    Start-Sleep 5
    $s = netsh wlan show interfaces | Out-String
    if ($s -match 'State\s+:\s+connected' -and $s -match [regex]::Escape($homeSsid)) { $staOk = $true; break }
  }
}
if ($staOk) { Write-Host "STA 已连 $homeSsid,热点将跟随其 2.4G 信道" -ForegroundColor Green }
else { Write-Host "STA 未连上 $homeSsid,热点可能停在 5GHz(学习机搜不到)——检查家里 WiFi 密码" -ForegroundColor Yellow }

# 2) 启动热点(此卡 STA/AP 并发状态机易毛:start 失败报"设备未正常工作"时,
#    断开 STA、清残留再试一次,实测必成)
netsh wlan stop hostednetwork 2>$null | Out-Null
netsh wlan set hostednetwork mode=allow ssid=$Ssid key=$Key keyUsage=persistent | Out-Null
netsh wlan start hostednetwork | Out-Null
Start-Sleep 4
$started = ((netsh wlan show hostednetwork) | Out-String) -match 'Status\s*:\s*Started'
if (-not $started) {
  netsh wlan disconnect 2>$null | Out-Null      # 断 STA 清并发残留
  Start-Sleep 5
  netsh wlan start hostednetwork | Out-Null
  Start-Sleep 5
  $started = ((netsh wlan show hostednetwork) | Out-String) -match 'Status\s*:\s*Started'
}
if ($started) { Write-Host "热点已广播: $Ssid / $Key  (WPA2-Personal, 2.4G)" -ForegroundColor Green }
else { Write-Host "热点启动失败! 重跑一次本脚本;仍失败则:拔插 USB 网卡后重试" -ForegroundColor Red }

# 3) 找到虚拟 AP 适配器(名字随机"本地连接* NN",按描述找)
$ap = Get-NetAdapter -IncludeHidden | Where-Object { $_.InterfaceDescription -like '*Hosted Network*' } | Select-Object -First 1
if (-not $ap) { Write-Host '未找到 Hosted Network 虚拟适配器' -ForegroundColor Red; exit 1 }

# 4) ICS 共享尝试(此机 ICS COM 已坏死 EnableSharing(1) 必报 0x80040201,失败不影响功能:
#    DHCP 由内置 dhcp-server.js 提供,无需 ICS NAT)
try {
$gwAlias = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue |
  Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias
$ns = New-Object -ComObject HNetCfg.HNetShare
$pub = $null; $prv = $null
foreach ($c in $ns.EnumEveryConnection) {
  $n = $ns.NetConnectionProps($c).Name
  if ($n -eq $gwAlias) { $pub = $c }
  if ($n -eq $ap.Name) { $prv = $c }
}
if ($pub -and $prv) {
  $pubCfg = $ns.INetSharingConfigurationForINetConnection($pub)
  $prvCfg = $ns.INetSharingConfigurationForINetConnection($prv)
  if (-not $pubCfg.SharingEnabled) { $pubCfg.EnableSharing(0) | Out-Null; Start-Sleep 1 }
  if ($prvCfg.SharingEnabled) { $prvCfg.DisableSharing() | Out-Null; Start-Sleep 1 }   # 清残留再挂
  if (-not $prvCfg.SharingEnabled) { $prvCfg.EnableSharing(1) | Out-Null }
  Write-Host "ICS 共享: $gwAlias → $($ap.Name) (热点设备将拿到 192.168.137.x,网关/DNS=192.168.137.1)" -ForegroundColor Green
} else {
  Write-Host "自动挂ICS失败(出口:$gwAlias 热点:$($ap.Name))。手动:控制面板→网络连接→$gwAlias 属性→共享→允许其它网络连接→选 $($ap.Name)" -ForegroundColor Yellow
}
} catch { Write-Host "ICS 共享:本机 COM 已坏死($($_.Exception.Message))——无影响,内置 DHCP 已接管" -ForegroundColor Yellow }

# 5) 关掉 ICS 的 DNS 代理(否则它会截走热点客户端发往 137.1:53 的查询,拦截失效)
$sa = 'HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters'
if ((Get-ItemProperty $sa -EA SilentlyContinue).DnsProxyEnabled -ne 0) {
  New-ItemProperty -Path $sa -Name DnsProxyEnabled -PropertyType DWord -Value 0 -Force | Out-Null
  Restart-Service SharedAccess -Force -EA SilentlyContinue
  Write-Host 'ICS DNS 代理已关闭(sinkhole 直接应答客户端)' -ForegroundColor Green
}
Write-Host "`n完成。设备连接 $Ssid 后浏览器打开 http://iflytek.com" -ForegroundColor Cyan
