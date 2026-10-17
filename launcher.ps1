# =====================================================================
#  launcher.ps1 —— 中继站管理器(编译成 中继站管理器.exe,Win10/11 自带 .NET 可直跑)
#  可视化:启动/停止/重启服务、状态灯(53/80/443/28791)、打开中继站/管理后台、
#          热点开关 + 无线网卡选择 + SSID/密码、配置对话框(写 config.json)
#  管理员:exe 壳内嵌 requireAdministrator manifest,双击自动弹 UAC
#          (开热点/写 Program Files/防火墙都必须管理员)
#  参数: -InlineConfig 启动后直接弹配置窗; -AutoScreenshot/-ProbeFile 自动化测试
# =====================================================================
param([switch]$InlineConfig, [string]$AutoScreenshot = '', [string]$ProbeFile = '')
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$root = $PSScriptRoot
$cfgFile = Join-Path $root 'config.json'
$u8 = New-Object System.Text.UTF8Encoding($false)

function Read-Cfg {
  try { return ([IO.File]::ReadAllText($cfgFile, $u8) | ConvertFrom-Json) } catch { return $null }
}
function Write-Cfg($cfg) { [IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 12), $u8) }

# ---------- 状态查询 ----------
function Get-SvcProcs {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*--svc-sinkhole*' })
}
function Get-PortListen([int]$port) {
  try { return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
  catch { return $false }
}
function Get-HostedState {
  $out = netsh wlan show hostednetwork 2>&1 | Out-String
  if ($out -match 'Status\s*:\s*Started') { return '已开启' }
  if ($out -match 'not available|不可用|cannot be') { return '不可用' }
  if ($out -match 'Status\s*:\s*Stopped|状态\s*:\s*已停止|停止') { return '已停止' }
  return '不可用'
}
function Get-WifiNics {
  # 所有无线网卡(内置+USB),返回 @{Name;Desc;Wifi;Hosted}
  $out = @()
  $adapters = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
    Where-Object { $_.Status -ne 'Disabled' -and ($_.InterfaceDescription -match 'Wi-?Fi|Wireless|WLAN|802\.11|Wireless-AC|AX\d+' -or $_.Name -match 'WLAN|Wi-?Fi') })
  foreach ($a in $adapters) {
    $out += [pscustomobject]@{ Name = $a.Name; Desc = $a.InterfaceDescription }
  }
  return $out
}
function Start-Svc {
  $ex = Join-Path $root 'runtime\node.exe'
  if (-not (Test-Path $ex)) { $ex = 'node.exe' }
  try {
    Start-Process -FilePath $ex -ArgumentList ('"{0}"' -f (Join-Path $root 'index.js')), '--svc-sinkhole' -WorkingDirectory $root -WindowStyle Hidden
    return $true
  } catch { return $false }
}
function Stop-Svc {
  Get-SvcProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Open-Page($url) {
  # 浏览器被占用/无默认浏览器时兜底 Edge
  try { Start-Process $url } catch {
    try { Start-Process msedge.exe -ArgumentList ('"{0}"' -f $url) } catch {
      try { Start-Process 'cmd.exe' -ArgumentList ('/c start "" "{0}"' -f $url) } catch {
        [System.Windows.Forms.MessageBox]::Show("打不开浏览器,请手动访问:`n$url", '提示') | Out-Null
      }
    }
  }
}
function Open-Admin($page) {
  if (-not (Get-PortListen 80)) { Start-Svc }   # 反代没起,80 不通 → 拉起服务
  Open-Page ('http://iflytek.com' + $page)
}

# ================= 窗体 =================
$f = New-Object System.Windows.Forms.Form
$f.Text = '中继站管理器 · iflytek-sinkhole'
$f.Size = New-Object System.Drawing.Size(640, 660)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedSingle'
$f.MaximizeBox = $false
$f.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'LAN 中继站 · 管理器'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true; $title.Location = '20,16'; $f.Controls.Add($title)

$adminTag = New-Object System.Windows.Forms.Label
$adminTag.Text = ''
$adminTag.AutoSize = $true; $adminTag.ForeColor = [System.Drawing.Color]::DimGray; $adminTag.Location = '500,24'; $f.Controls.Add($adminTag)

$pathLb = New-Object System.Windows.Forms.Label
$pathLb.Text = $root
$pathLb.AutoSize = $true; $pathLb.ForeColor = [System.Drawing.Color]::Gray; $pathLb.Location = '24,48'; $f.Controls.Add($pathLb)

# ---------- 服务区 ----------
$svcBox = New-Object System.Windows.Forms.GroupBox
$svcBox.Text = '服务'
$svcBox.Location = '20,76'; $svcBox.Size = '590,116'; $f.Controls.Add($svcBox)

$svcDot = New-Object System.Windows.Forms.Label
$svcDot.Text = '●'; $svcDot.Font = New-Object System.Drawing.Font('Consolas', 16)
$svcDot.ForeColor = [System.Drawing.Color]::Gray; $svcDot.AutoSize = $true; $svcDot.Location = '18,26'; $svcBox.Controls.Add($svcDot)

$svcTxt = New-Object System.Windows.Forms.Label
$svcTxt.Text = '检测中…'; $svcTxt.AutoSize = $true; $svcTxt.Location = '48,30'; $svcBox.Controls.Add($svcTxt)

$portTxt = New-Object System.Windows.Forms.Label
$portTxt.Text = ''; $portTxt.AutoSize = $true; $portTxt.ForeColor = [System.Drawing.Color]::DimGray; $portTxt.Location = '48,58'; $svcBox.Controls.Add($portTxt)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = '启动'; $btnStart.Location = '18,82'; $btnStart.Size = '86,26'
$btnStart.Add_Click({
  if (Start-Svc) { $svcTxt.Text = '启动中…(首次冷启动 Defender 扫描可能要几分钟)' }
  else { [System.Windows.Forms.MessageBox]::Show('启动失败:检查 runtime\node.exe 是否存在', '错误') | Out-Null }
  Refresh-Status
})
$svcBox.Controls.Add($btnStart)

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text = '停止'; $btnStop.Location = '110,82'; $btnStop.Size = '86,26'
$btnStop.Add_Click({ Stop-Svc; Start-Sleep 1; Refresh-Status })
$svcBox.Controls.Add($btnStop)

$btnRe = New-Object System.Windows.Forms.Button
$btnRe.Text = '重启'; $btnRe.Location = '202,82'; $btnRe.Size = '86,26'
$btnRe.Add_Click({ Stop-Svc; Start-Sleep 1; [void](Start-Svc); Start-Sleep 1; Refresh-Status })
$svcBox.Controls.Add($btnRe)

$btnDir = New-Object System.Windows.Forms.Button
$btnDir.Text = '打开目录'; $btnDir.Location = '384,82'; $btnDir.Size = '92,26'
$btnDir.Add_Click({ Start-Process explorer.exe -ArgumentList ('"{0}"' -f $root) })
$svcBox.Controls.Add($btnDir)

$btnLog = New-Object System.Windows.Forms.Button
$btnLog.Text = '看日志'; $btnLog.Location = '482,82'; $btnLog.Size = '92,26'
$btnLog.Add_Click({ $l = Join-Path $root 'logs\sinkhole.log'; if (Test-Path $l) { Start-Process notepad.exe -ArgumentList ('"{0}"' -f $l) } else { [System.Windows.Forms.MessageBox]::Show('还没有日志(服务未跑过)', '提示') | Out-Null } })
$svcBox.Controls.Add($btnLog)

# ---------- 入口区 ----------
$navBox = New-Object System.Windows.Forms.GroupBox
$navBox.Text = '入口'
$navBox.Location = '20,204'; $navBox.Size = '590,84'; $f.Controls.Add($navBox)

$btnPortal = New-Object System.Windows.Forms.Button
$btnPortal.Text = '打开 http://iflytek.com (门户)'; $btnPortal.Location = '18,26'; $btnPortal.Size = '262,30'
$btnPortal.Add_Click({ Open-Page 'http://iflytek.com/' })
$navBox.Controls.Add($btnPortal)

$btnRelay = New-Object System.Windows.Forms.Button
$btnRelay.Text = '打开 中继站 /relay (本机直入)'; $btnRelay.Location = '296,26'; $btnRelay.Size = '278,30'
$btnRelay.Add_Click({ Open-Admin '/relay' })
$navBox.Controls.Add($btnRelay)

$btnAdm = New-Object System.Windows.Forms.Button
$btnAdm.Text = '打开 管理后台 /admin (身份组·流量·直连)'; $btnAdm.Location = '18,26'; $btnAdm.Size = '556,30'
$btnAdm.Visible = $false
$btnAdm.Add_Click({ Open-Page ('http://127.0.0.1:28791/admin') })
$navBox.Controls.Add($btnAdm)

$btnAdm2 = New-Object System.Windows.Forms.Button
$btnAdm2.Text = '管理后台 /admin →'; $btnAdm2.Location = '296,56'; $btnAdm2.Size = '278,22'
$btnAdm2.FlatStyle = 'Flat'; $btnAdm2.ForeColor = [System.Drawing.Color]::FromArgb(0, 102, 204)
$btnAdm2.Add_Click({ Open-Admin '/admin' })
$navBox.Controls.Add($btnAdm2)

# ---------- 热点区(含网卡选择) ----------
$hotBox = New-Object System.Windows.Forms.GroupBox
$hotBox.Text = '热点 (hostednetwork 伪装 WiFi)'
$hotBox.Location = '20,300'; $hotBox.Size = '590,150'; $f.Controls.Add($hotBox)

$hotDot = New-Object System.Windows.Forms.Label
$hotDot.Text = '●'; $hotDot.Font = New-Object System.Drawing.Font('Consolas', 16)
$hotDot.ForeColor = [System.Drawing.Color]::Gray; $hotDot.AutoSize = $true; $hotDot.Location = '18,30'; $hotBox.Controls.Add($hotDot)

$hotTxt = New-Object System.Windows.Forms.Label
$hotTxt.Text = '检测中…'; $hotTxt.AutoSize = $true; $hotTxt.Location = '48,34'; $hotBox.Controls.Add($hotTxt)

$nicLb = New-Object System.Windows.Forms.Label
$nicLb.Text = '无线网卡:'; $nicLb.AutoSize = $true; $nicLb.Location = '18,62'; $hotBox.Controls.Add($nicLb)

$nicCmb = New-Object System.Windows.Forms.ComboBox
$nicCmb.DropDownStyle = 'DropDownList'; $nicCmb.Location = '88,58'; $nicCmb.Size = '330,26'; $hotBox.Controls.Add($nicCmb)

$btnNicRe = New-Object System.Windows.Forms.Button
$btnNicRe.Text = '刷新'; $btnNicRe.Location = '426,57'; $btnNicRe.Size = '64,26'
$btnNicRe.Add_Click({ Load-Nics })
$hotBox.Controls.Add($btnNicRe)

$ssidLb = New-Object System.Windows.Forms.Label
$ssidLb.Text = 'SSID:'; $ssidLb.AutoSize = $true; $ssidLb.Location = '18,96'; $hotBox.Controls.Add($ssidLb)
$ssidTb = New-Object System.Windows.Forms.TextBox
$ssidTb.Location = '88,92'; $ssidTb.Size = '150,24'; $hotBox.Controls.Add($ssidTb)
$keyLb = New-Object System.Windows.Forms.Label
$keyLb.Text = '密码:'; $keyLb.AutoSize = $true; $keyLb.Location = '250,96'; $hotBox.Controls.Add($keyLb)
$keyTb = New-Object System.Windows.Forms.TextBox
$keyTb.Location = '300,92'; $keyTb.Size = '150,24'; $hotBox.Controls.Add($keyTb)
$btnHotSave = New-Object System.Windows.Forms.Button
$btnHotSave.Text = '保存热点配置'; $btnHotSave.Location = '460,91'; $btnHotSave.Size = '106,26'
$btnHotSave.Add_Click({ Save-HotspotCfg })
$hotBox.Controls.Add($btnHotSave)

$btnHot = New-Object System.Windows.Forms.Button
$btnHot.Text = '开热点'; $btnHot.Location = '18,122'; $btnHot.Size = '96,24'
$btnHot.Add_Click({ Run-Hotspot $false })
$hotBox.Controls.Add($btnHot)

$btnHotStop = New-Object System.Windows.Forms.Button
$btnHotStop.Text = '关热点'; $btnHotStop.Location = '120,122'; $btnHotStop.Size = '96,24'
$btnHotStop.Add_Click({ Run-Hotspot $true })
$hotBox.Controls.Add($btnHotStop)

$hotInfo = New-Object System.Windows.Forms.Label
$hotInfo.Text = ''; $hotInfo.AutoSize = $true; $hotInfo.ForeColor = [System.Drawing.Color]::DimGray; $hotInfo.Location = '240,126'; $hotBox.Controls.Add($hotInfo)

# ---------- 热点操作 ----------
function Load-Nics {
  $cur = $nicCmb.Text
  $nicCmb.Items.Clear()
  $cfg = Read-Cfg
  $saved = ''
  if ($cfg -and $cfg.relay -and $cfg.relay.hotspot -and $cfg.relay.hotspot.nic) { $saved = [string]$cfg.relay.hotspot.nic }
  $nics = Get-WifiNics
  if (-not $nics -or $nics.Count -eq 0) {
    $nicCmb.Items.Add('(未检测到无线网卡 —— 插上 USB 无线网卡后点「刷新」)')
    $nicCmb.SelectedIndex = 0
    return
  }
  foreach ($n in $nics) { $nicCmb.Items.Add(('{0}  [{1}]' -f $n.Name, $n.Desc)) | Out-Null }
  $idx = 0
  if ($cur) { $idx = $nicCmb.Items.IndexOf($cur) }
  if ($idx -lt 0 -and $saved) {
    for ($i = 0; $i -lt $nicCmb.Items.Count; $i++) { if ($nicCmb.Items[$i] -like ($saved + '*')) { $idx = $i; break } }
  }
  if ($idx -lt 0) { $idx = 0 }
  $nicCmb.SelectedIndex = $idx
}
function Get-SelNic {
  if ($nicCmb.SelectedIndex -lt 0) { return '' }
  $t = [string]$nicCmb.SelectedItem
  if ($t -like '(未检测到*') { return '' }
  return ($t -split '\s+\[')[0].Trim()
}
function Save-HotspotCfg {
  $cfg = Read-Cfg
  if (-not $cfg) { [System.Windows.Forms.MessageBox]::Show('读不到 config.json', '错误') | Out-Null; return }
  if (-not $cfg.relay.hotspot) { $cfg.relay | Add-Member hotspot ([PSCustomObject]@{}) -Force }
  $ssid = $ssidTb.Text.Trim(); $key = $keyTb.Text
  if (-not $ssid) { [System.Windows.Forms.MessageBox]::Show('SSID 不能为空', '提示') | Out-Null; return }
  if ($key.Length -gt 0 -and $key.Length -lt 8) { [System.Windows.Forms.MessageBox]::Show('WiFi 密码至少 8 位', '提示') | Out-Null; return }
  $cfg.relay.hotspot | Add-Member ssid $ssid -Force
  if ($key) { $cfg.relay.hotspot | Add-Member key $key -Force }
  $nic = Get-SelNic
  if ($nic) { $cfg.relay.hotspot | Add-Member nic $nic -Force }
  try {
    Write-Cfg $cfg
    [System.Windows.Forms.MessageBox]::Show("已保存(下次「开热点」即用):`nSSID = $ssid`n网卡 = $(if ($nic) { $nic } else { '自动' })", '完成') | Out-Null
  } catch { [System.Windows.Forms.MessageBox]::Show("保存失败: $($_.Exception.Message)", '错误') | Out-Null }
}
function Run-Hotspot([bool]$stop) {
  $hs = Join-Path $root 'hotspot.ps1'
  if (-not (Test-Path $hs)) { [System.Windows.Forms.MessageBox]::Show('缺 hotspot.ps1', '错误') | Out-Null; return }
  $logDir = Join-Path $root 'logs'
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  $arg = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $hs))
  if ($stop) {
    $arg += '-Stop'
  } else {
    $cfg = Read-Cfg
    $nic = ''
    if ($cfg -and $cfg.relay -and $cfg.relay.hotspot -and $cfg.relay.hotspot.nic) { $nic = [string]$cfg.relay.hotspot.nic }
    if (-not $nic) { $nic = Get-SelNic }
    if ($nic) { $arg += @('-Nic', ('"{0}"' -f $nic)) }
  }
  $info = if ($stop) { '正在关闭热点…' } else { '正在开热点(可能要 20~60 秒,含跟随 2.4G 信道)' }
  $old = $hotInfo.Text; $hotInfo.Text = $info; $f.Refresh()
  try {
    $ok = $true
    $p = Start-Process powershell.exe -ArgumentList $arg -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'hotspot.out.log') -RedirectStandardError (Join-Path $logDir 'hotspot.err.log')
    if ($p) { $p.WaitForExit() }
  } catch {
    $ok = $false
    if ($stop) { netsh wlan stop hostednetwork 2>&1 | Out-Null; $ok = $true }  # 兜底:直接 netsh 关
  }
  Start-Sleep 1
  Refresh-Status
  if (-not $ok) {
    $err = ''
    try { $err = (Get-Content (Join-Path $logDir 'hotspot.out.log') -Tail 5 -EA SilentlyContinue) -join "`n" } catch {}
    [System.Windows.Forms.MessageBox]::Show("开热点失败(详情 logs\hotspot.out.log):`n$err", '热点') | Out-Null
  }
}

# ---------- 配置按钮 ----------
$btnCfg = New-Object System.Windows.Forms.Button
$btnCfg.Text = '配置(拦截域名 / 上传上限 / 登录开关 / 伪装门户 / 上游DNS)'
$btnCfg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$btnCfg.Location = '20,464'; $btnCfg.Size = '590,36'
$btnCfg.Add_Click({ Show-Config })
$f.Controls.Add($btnCfg)

$tipLb = New-Object System.Windows.Forms.Label
$tipLb.Text = '状态灯每 4 秒自动刷新 · 改完配置点「重启」生效 · 卸载: uninstall-on-this-pc.ps1'
$tipLb.AutoSize = $true; $tipLb.ForeColor = [System.Drawing.Color]::Gray; $tipLb.Location = '24,512'; $f.Controls.Add($tipLb)

# ---------- 状态刷新 ----------
function Refresh-Status {
  $procs = Get-SvcProcs
  $running = $procs.Count -gt 0
  if ($running) {
    $svcDot.ForeColor = [System.Drawing.Color]::FromArgb(31, 122, 77)
    $svcTxt.Text = "运行中 (PID $($procs[0].ProcessId))"
  } else {
    $svcDot.ForeColor = [System.Drawing.Color]::FromArgb(179, 38, 30)
    $svcTxt.Text = '未运行'
  }
  $bits = @()
  foreach ($p in @('53', '80', '443', '28791')) {
    $up = Get-PortListen ([int]$p)
    $bits += "$p " + $(if ($up) { '✓' } else { '✗' })
  }
  $portTxt.Text = '端口: ' + ($bits -join '   ')
  $st = Get-HostedState
  $hotTxt.Text = "热点: $st"
  $hotDot.ForeColor = if ($st -eq '已开启') { [System.Drawing.Color]::FromArgb(31, 122, 77) } elseif ($st -eq '不可用') { [System.Drawing.Color]::DimGray } else { [System.Drawing.Color]::FromArgb(166, 124, 0) }
  $hotInfo.Text = if ($st -eq '已开启') { '设备连上后开 http://iflytek.com 即进中继站' } else { '选网卡 → 保存热点配置 → 开热点' }
  $btnStart.Enabled = -not $running
  $btnStop.Enabled = $running
  $btnHot.Enabled = ($st -ne '已开启')
  $btnHotStop.Enabled = ($st -eq '已开启')
}

# ---------- 配置对话框 ----------
function Show-Config {
  $cfg = Read-Cfg
  if (-not $cfg) { [System.Windows.Forms.MessageBox]::Show("读不到 config.json:$cfgFile", '错误') | Out-Null; return }

  $d = New-Object System.Windows.Forms.Form
  $d.Text = '配置 · config.json'
  $d.Size = New-Object System.Drawing.Size(560, 400)
  $d.StartPosition = 'CenterParent'
  $d.FormBorderStyle = 'FixedSingle'
  $d.MaximizeBox = $false
  $d.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

  function Add-Row($y, $label, $control) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $label; $l.AutoSize = $true; $l.Location = "24,$y"; $d.Controls.Add($l)
    $control.Location = "240,$([int]$y - 4)"
    $d.Controls.Add($control)
  }

  $n1 = New-Object System.Windows.Forms.TextBox
  $n1.Text = $cfg.sinkholeDomain; $n1.Size = '260,24'
  Add-Row 30 '拦截域名(换后重跑 make-cert.ps1):' $n1

  $n2 = New-Object System.Windows.Forms.CheckBox
  $n2.Text = '连 *.子域一起拦(会弄坏讯飞输入法在线功能)'
  $n2.AutoSize = $true; $n2.Checked = [bool]$cfg.blockSubdomains
  Add-Row 66 '子域拦截:' $n2

  $n3 = New-Object System.Windows.Forms.TextBox
  $n3.Text = $cfg.relay.maxUploadMB; $n3.Size = '100,24'
  Add-Row 102 '上传上限 (MB):' $n3

  $n4 = New-Object System.Windows.Forms.CheckBox
  $n4.Text = '开启登录鉴权(账号密码,关了=局域网免登录)'
  $n4.AutoSize = $true; $n4.Checked = [bool]$cfg.relay.auth.enabled
  Add-Row 138 '登录鉴权:' $n4

  $n5 = New-Object System.Windows.Forms.CheckBox
  $n5.Text = '伪装门户(访问 / 实时镜像讯飞官网,点 logo 进暗门)'
  $n5.AutoSize = $true; $n5.Checked = [bool]$cfg.relay.mirror.enabled
  Add-Row 174 '伪装门户:' $n5

  $n6 = New-Object System.Windows.Forms.TextBox
  $n6.Text = @($cfg.upstreamDNS) -join ', '; $n6.Size = '300,24'
  Add-Row 210 '上游 DNS(逗号分隔):' $n6

  $n8 = New-Object System.Windows.Forms.CheckBox
  $n8.Text = '保存后立即重启服务(推荐)'
  $n8.AutoSize = $true; $n8.Checked = $true
  Add-Row 246 '保存时:' $n8

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '保存'
  $ok.BackColor = [System.Drawing.Color]::FromArgb(217, 79, 43)
  $ok.ForeColor = [System.Drawing.Color]::White; $ok.FlatStyle = 'Flat'
  $ok.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
  $ok.Location = '24,300'; $ok.Size = '220,44'
  $ok.Add_Click({
    try {
      $mb = 0
      if (-not [int]::TryParse($n3.Text, [ref]$mb)) { $mb = $cfg.relay.maxUploadMB }
      if ($mb -lt 1) { $mb = 1 }
      $cfg.sinkholeDomain = $n1.Text.Trim()
      $cfg.blockSubdomains = [bool]$n2.Checked
      $cfg.relay.maxUploadMB = $mb
      $cfg.relay.auth.enabled = [bool]$n4.Checked
      $cfg.relay.mirror.enabled = [bool]$n5.Checked
      $up = @($n6.Text -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($up.Count) { $cfg.upstreamDNS = $up }
      Write-Cfg $cfg
      if ($n8.Checked) { Stop-Svc; Start-Sleep 1; [void](Start-Svc) }
      [System.Windows.Forms.MessageBox]::Show('已保存' + $(if ($n8.Checked) { ',服务重启中(状态灯稍后刷新)' } else { ' (未重启,手动点「重启」生效)' }), '完成') | Out-Null
      $d.DialogResult = [System.Windows.Forms.DialogResult]::OK
      $d.Close()
      Start-Sleep 1
      Refresh-Status
    } catch {
      [System.Windows.Forms.MessageBox]::Show("保存失败: $($_.Exception.Message)", '错误') | Out-Null
    }
  })
  $d.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '取消'; $cancel.Location = '264,300'; $cancel.Size = '160,44'
  $cancel.Add_Click({ $d.Close() })
  $d.Controls.Add($cancel)

  $d.ShowDialog($f) | Out-Null
}

# ---------- 初始化 / 定时刷新 ----------
function Init-HotspotFields {
  $cfg = Read-Cfg
  if ($cfg -and $cfg.relay -and $cfg.relay.hotspot) {
    $ssidTb.Text = [string]$cfg.relay.hotspot.ssid
    $keyTb.Text = [string]$cfg.relay.hotspot.key
  }
  if (-not $ssidTb.Text) { $ssidTb.Text = 'China_Unicom' }
  if (-not $keyTb.Text) { $keyTb.Text = 'unicom2026' }
}

# 管理员标记
try {
  $idn = [Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = (New-Object Security.Principal.WindowsPrincipal($idn)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $adminTag.Text = $(if ($isAdmin) { '管理员 ✓' } else { '⚠ 非管理员' })
} catch {}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ try { Refresh-Status } catch {} })
$timer.Start()
$f.Add_Shown({
  try { Init-HotspotFields } catch {}
  try { Load-Nics } catch {}
  try { Refresh-Status } catch {}
  if ($InlineConfig) { Show-Config }
})

# ---------- 自动化测试:隐藏窗 + 截图 + 探针 ----------
if ($AutoScreenshot -or $ProbeFile) {
  $f.ShowInTaskbar = $false
  $f.Add_Shown({
    Start-Sleep -Milliseconds 900
    try {
      if ($ProbeFile) {
        $probe = "root=$root;config=$(Test-Path $cfgFile);nics=$($nicCmb.Items.Count);ssid=$($ssidTb.Text);window=shown"
        [IO.File]::WriteAllText($ProbeFile, $probe, $u8)
      }
    } catch { try { [IO.File]::WriteAllText($ProbeFile, "ERR $($_.Exception.Message)", $u8) } catch {} }
    $f.Close()
  })
}

$f.ShowDialog() | Out-Null
exit 0
