# =====================================================================
#  launcher.ps1 —— 中继站管理器(编译成 中继站管理器.exe,W10/11 自带 .NET 可直跑)
#  可视化:启动/停止/重启服务、状态灯(53/80/443/28791 端口)、打开中继站/管理后台、
#          热点开关(hostednetwork)、配置对话框(写 config.json)、打开目录/日志
#  参数: -InlineConfig 启动后直接弹配置窗(装完结果页"改配置"按钮用)
#  自动化测试: 隐藏窗体 -AutoScreenshot <png> 截图后退出; -ProbeFile <file> 写探针标记
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
  try {
    $l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$l
  } catch { return $false }
}
function Get-HostedState {
  $out = netsh wlan show hostednetwork 2>&1 | Out-String
  if ($out -match 'Status\s*:\s*Started') { return '已开启' }
  if ($out -match 'not running|未运行|started|Settings') { if ($out -match 'Settings\s*:') { return '已停止' } }
  if ($out -match '承载网络') { return '已停止' }
  return '不可用'
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
function Open-Admin($page) {
  $ex = Join-Path $root 'runtime\node.exe'
  if (-not (Test-Path $ex)) { return }
  # 确保反代在跑,否则 80 不通
  if (-not (Get-PortListen 80)) { Start-Svc }
  Start-Process ('http://127.0.0.1' + $page)
}

# ================= 窗体 =================
$f = New-Object System.Windows.Forms.Form
$f.Text = '中继站管理器 · iflytek-sinkhole'
$f.Size = New-Object System.Drawing.Size(620, 560)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedSingle'
$f.MaximizeBox = $false
$f.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'LAN 中继站 · 管理器'
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true; $title.Location = '20,16'; $f.Controls.Add($title)

$pathLb = New-Object System.Windows.Forms.Label
$pathLb.Text = $root
$pathLb.AutoSize = $true; $pathLb.ForeColor = [System.Drawing.Color]::Gray; $pathLb.Location = '24,48'; $f.Controls.Add($pathLb)

# 服务状态区
$svcBox = New-Object System.Windows.Forms.GroupBox
$svcBox.Text = '服务'
$svcBox.Location = '20,76'; $svcBox.Size = '570,116'; $f.Controls.Add($svcBox)

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
  if (Start-Svc) { $svcTxt.Text = '启动中…(首扫需 5-8 分钟,状态灯轮询自动刷新)' }
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
$btnRe.Add_Click({ Stop-Svc; Start-Sleep 1; if (Start-Svc) { }; Start-Sleep 1; Refresh-Status })
$svcBox.Controls.Add($btnRe)

$btnDir = New-Object System.Windows.Forms.Button
$btnDir.Text = '打开目录'; $btnDir.Location = '384,82'; $btnDir.Size = '86,26'
$btnDir.Add_Click({ Start-Process explorer.exe -ArgumentList $root })
$svcBox.Controls.Add($btnDir)

$btnLog = New-Object System.Windows.Forms.Button
$btnLog.Text = '看日志'; $btnLog.Location = '476,82'; $btnLog.Size = '78,26'
$btnLog.Add_Click({ $l = Join-Path $root 'logs\sinkhole.log'; if (Test-Path $l) { Start-Process notepad.exe -ArgumentList ('"{0}"' -f $l) } else { [System.Windows.Forms.MessageBox]::Show('还没有日志(服务未跑过)', '提示') | Out-Null } })
$svcBox.Controls.Add($btnLog)

# 入口区
$navBox = New-Object System.Windows.Forms.GroupBox
$navBox.Text = '入口'
$navBox.Location = '20,204'; $navBox.Size = '570,84'; $f.Controls.Add($navBox)

$btnPortal = New-Object System.Windows.Forms.Button
$btnPortal.Text = '打开 http://iflytek.com (门户)'; $btnPortal.Location = '18,26'; $btnPortal.Size = '250,30'
$btnPortal.Add_Click({ Start-Process 'http://iflytek.com/' })
$navBox.Controls.Add($btnPortal)

$btnRelay = New-Object System.Windows.Forms.Button
$btnRelay.Text = '打开 中继站 /relay (本机管理员)'; $btnRelay.Location = '284,26'; $btnRelay.Size = '270,30'
$btnRelay.Add_Click({ Open-Admin '/relay' })
$navBox.Controls.Add($btnRelay)

$btnAdm = New-Object System.Windows.Forms.Button
$btnAdm.Text = '打开 管理后台 /admin (身份组·流量)'; $btnAdm.Location = '18,26'; $btnAdm.Size = '250,30'
$btnAdm.Visible = $false
$btnAdm.Add_Click({ Open-Admin '/admin' })
$navBox.Controls.Add($btnAdm)

# 热点区
$hotBox = New-Object System.Windows.Forms.GroupBox
$hotBox.Text = '热点 (hostednetwork 伪装 WiFi)'
$hotBox.Location = '20,300'; $hotBox.Size = '570,96'; $f.Controls.Add($hotBox)

$hotDot = New-Object System.Windows.Forms.Label
$hotDot.Text = '●'; $hotDot.Font = New-Object System.Drawing.Font('Consolas', 16)
$hotDot.ForeColor = [System.Drawing.Color]::Gray; $hotDot.AutoSize = $true; $hotDot.Location = '18,30'; $hotBox.Controls.Add($hotDot)

$hotTxt = New-Object System.Windows.Forms.Label
$hotTxt.Text = '检测中…'; $hotTxt.AutoSize = $true; $hotTxt.Location = '48,34'; $hotBox.Controls.Add($hotTxt)

$btnHot = New-Object System.Windows.Forms.Button
$btnHot.Text = '开热点'; $btnHot.Location = '18,60'; $btnHot.Size = '96,26'
$btnHot.Add_Click({ Run-Hotspot $false })
$hotBox.Controls.Add($btnHot)

$btnHotStop = New-Object System.Windows.Forms.Button
$btnHotStop.Text = '关热点'; $btnHotStop.Location = '120,60'; $btnHotStop.Size = '96,26'
$btnHotStop.Add_Click({ Run-Hotspot $true })
$hotBox.Controls.Add($btnHotStop)

$hotInfo = New-Object System.Windows.Forms.Label
$hotInfo.Text = ''; $hotInfo.AutoSize = $true; $hotInfo.ForeColor = [System.Drawing.Color]::DimGray; $hotInfo.Location = '240,64'; $hotBox.Controls.Add($hotInfo)

function Run-Hotspot([bool]$stop) {
  $hs = Join-Path $root 'hotspot.ps1'
  if (-not (Test-Path $hs)) { [System.Windows.Forms.MessageBox]::Show('缺 hotspot.ps1', '错误') | Out-Null; return }
  $a = if ($stop) { '-Stop' } else { '' }
  $log = Join-Path $root 'logs\hotspot.out.log'
  if (-not (Test-Path (Join-Path $root 'logs'))) { New-Item -ItemType Directory -Path (Join-Path $root 'logs') | Out-Null }
  $arg = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $hs))
  if ($a) { $arg += $a }
  Start-Process powershell.exe -ArgumentList $arg -Wait -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError (Join-Path $root 'logs\hotspot.err.log') | Out-Null
  Start-Sleep 1
  Refresh-Status
}

# 配置按钮
$btnCfg = New-Object System.Windows.Forms.Button
$btnCfg.Text = '配置(拦截域名 / 上传上限 / 登录开关 / 热点 / 上游DNS)'
$btnCfg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$btnCfg.Location = '20,410'; $btnCfg.Size = '570,34'
$btnCfg.Add_Click({ Show-Config })
$f.Controls.Add($btnCfg)

$tipLb = New-Object System.Windows.Forms.Label
$tipLb.Text = '状态灯每 4 秒自动刷新 · 改完配置点「重启」生效 · 卸载: uninstall-on-this-pc.ps1'
$tipLb.AutoSize = $true; $tipLb.ForeColor = [System.Drawing.Color]::Gray; $tipLb.Location = '24,456'; $f.Controls.Add($tipLb)

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
  $ports = @('53 DNS', '80 HTTP', '443 HTTPS', '28791 中继')
  $bits = @()
  foreach ($p in @('53', '80', '443', '28791')) {
    $up = Get-PortListen ([int]$p)
    $bits += "$p " + $(if ($up) { '✓' } else { '✗' })
  }
  $portTxt.Text = '端口: ' + ($bits -join '   ')
  $st = Get-HostedState
  $hotTxt.Text = "热点: $st"
  $hotDot.ForeColor = if ($st -eq '已开启') { [System.Drawing.Color]::FromArgb(31, 122, 77) } elseif ($st -eq '不可用') { [System.Drawing.Color]::DimGray } else { [System.Drawing.Color]::FromArgb(166, 124, 0) }
  $hotInfo.Text = if ($st -eq '已开启') { '设备连上后开 http://iflytek.com 即进中继站' } else { '开热点前需 USB 无线网卡 + 管理员权限' }
  $btnStart.Enabled = -not $running
  $btnStop.Enabled = $running
}

# ---------- 配置对话框 ----------
function Show-Config {
  $cfg = Read-Cfg
  if (-not $cfg) { [System.Windows.Forms.MessageBox]::Show("读不到 config.json:$cfgFile", '错误') | Out-Null; return }

  $d = New-Object System.Windows.Forms.Form
  $d.Text = '配置 · config.json'
  $d.Size = New-Object System.Drawing.Size(560, 440)
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

  $n7 = New-Object System.Windows.Forms.CheckBox
  $n7.Text = '开热点(SSID/密码在 hotspot.ps1,或 config relay.hotspot)'
  $n7.AutoSize = $true
  $n7.Checked = if ($cfg.relay.hotspot -and $cfg.relay.hotspot.PSObject.Properties.Name -contains 'enabled') { [bool]$cfg.relay.hotspot.enabled } else { $true }
  Add-Row 246 '热点默认开:' $n7

  $n8 = New-Object System.Windows.Forms.CheckBox
  $n8.Text = '保存后立即重启服务(推荐)'
  $n8.AutoSize = $true; $n8.Checked = $true
  Add-Row 282 '保存时:' $n8

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '保存'
  $ok.BackColor = [System.Drawing.Color]::FromArgb(217, 79, 43)
  $ok.ForeColor = [System.Drawing.Color]::White; $ok.FlatStyle = 'Flat'
  $ok.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
  $ok.Location = '24,330'; $ok.Size = '220,44'
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
      if (-not $cfg.relay.hotspot) { $cfg.relay | Add-Member hotspot ([PSCustomObject]@{}) -Force }
      $cfg.relay.hotspot | Add-Member enabled ([bool]$n7.Checked) -Force
      Write-Cfg $cfg
      if ($n8.Checked) { Stop-Svc; Start-Sleep 1; Start-Svc }
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
  $cancel.Text = '取消'; $cancel.Location = '264,330'; $cancel.Size = '160,44'
  $cancel.Add_Click({ $d.Close() })
  $d.Controls.Add($cancel)

  $d.ShowDialog($f) | Out-Null
}

# ---------- 定时刷新 ----------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.Add_Tick({ try { Refresh-Status } catch {} })
$timer.Start()
$f.Add_Shown({ try { Refresh-Status } catch {}; if ($InlineConfig) { Show-Config } })

# ---------- 自动化测试:隐藏窗 + 截图 + 探针 ----------
if ($AutoScreenshot -or $ProbeFile) {
  $f.ShowInTaskbar = $false
  $f.Opacity = 0
  $f.StartPosition = 'Manual'
  $f.Location = '-4000,-4000'
  $f.Add_Shown({
    Start-Sleep -Milliseconds 800
    try {
      if ($ProbeFile) {
        $x = Join-Path $root 'config.json'
        $probe = "relayed=$(Test-Path $root\relay-site.js);config=$(Test-Path $cfgFile);window=shown"
        [IO.File]::WriteAllText($ProbeFile, $probe, $u8)
      }
      if ($AutoScreenshot) {
        Add-Type -Name GDI -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out int[] r);'
        Add-Type -AssemblyName System.Drawing | Out-Null
        $rect = New-Object System.Drawing.Rectangle $f.Location, $f.Size
        $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(2, $rect.Width)), ([Math]::Max(2, $rect.Height))
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($f.Location, [System.Drawing.Point]::Empty, $f.Size)
        $bmp.Save($AutoScreenshot, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
      }
    } catch {}
    $f.Close()
  })
}

$f.ShowDialog() | Out-Null
exit 0
