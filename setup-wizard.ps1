# =====================================================================
#  setup-wizard.ps1 —— 安装向导(WinForms),由 install.cmd 分两阶段调用
#    -Phase Ask   弹配置窗(目录/导入数据/热点/管理员账号) → 写 %TEMP%\iflytek-setup.cfg
#    -Phase Apply 读 cfg 应用:解压 data.zip(证书+storage) → 改 config.json → 跑 setup → 结果窗
#  无 cfg(Skip_Wizard 自动化)时:默认导入包内数据、不改配置,setup 按环境变量 SKIP_SETUP
#  cfg 行格式(GBK,cmd for /f 解析):DIR=/IMPORT=0|1/HOT=0|1/SSID=/HKEY=/USER=/PASS=
#  注意:目录/密码里别含 "="(cfg 按首 = 分割)。
# =====================================================================
param([ValidateSet('Ask','Apply')][string]$Phase = 'Ask', [string]$Src = '', [string]$Dst = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$cfgPath = Join-Path $env:TEMP 'iflytek-setup.cfg'
$gbk = [Text.Encoding]::GetEncoding(936)
$u8 = New-Object System.Text.UTF8Encoding($false)

function Read-JsonUtf8($p) {
  try { return ([IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json) } catch { return $null }
}
function Write-JsonUtf8($p, $obj) {
  [IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
}
function Read-Cfg {
  $h = @{}
  if (Test-Path $cfgPath) {
    foreach ($line in [IO.File]::ReadAllLines($cfgPath, $gbk)) {
      $i = $line.IndexOf('=')
      if ($i -gt 0) { $h[$line.Substring(0, $i)] = $line.Substring($i + 1) }
    }
  }
  return $h
}

if ($Phase -eq 'Ask') {
  # ---- 读包内 config.json 取默认值 ----
  $sc = $null
  if ($Src) { $sc = Read-JsonUtf8 (Join-Path $Src 'config.json') }
  $user = ''; $pass = ''
  if ($sc -and $sc.relay -and $sc.relay.auth -and $sc.relay.auth.accounts) {
    $props = @($sc.relay.auth.accounts.PSObject.Properties)
    if ($props.Count) { $user = $props[0].Name; $pass = $props[0].Value }
  }
  $ssid = 'China_Unicom'; $hkey = 'unicom2026'
  if ($sc -and $sc.relay -and $sc.relay.hotspot) {
    if ($sc.relay.hotspot.ssid) { $ssid = $sc.relay.hotspot.ssid }
    if ($sc.relay.hotspot.key) { $hkey = $sc.relay.hotspot.key }
  }
  $hasData = $Src -and (Test-Path (Join-Path $Src 'data.zip'))

  # ---- 主窗 ----
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'iflytek 中继站 — 安装向导'
  $f.Size = New-Object System.Drawing.Size(560, 470)
  $f.StartPosition = 'CenterScreen'
  $f.FormBorderStyle = 'FixedSingle'
  $f.MaximizeBox = $false
  $f.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = '局域网中继站 · 安装配置'
  $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
  $title.AutoSize = $true; $title.Location = '20,16'; $f.Controls.Add($title)

  $sub = New-Object System.Windows.Forms.Label
  $sub.Text = '确认下面的选项后点「开始安装」。所有选择只影响本机安装,不改包内文件。'
  $sub.AutoSize = $true; $sub.ForeColor = [System.Drawing.Color]::Gray; $sub.Location = '22,48'; $f.Controls.Add($sub)

  # 目录
  $l1 = New-Object System.Windows.Forms.Label
  $l1.Text = '安装目录:'; $l1.AutoSize = $true; $l1.Location = '24,86'; $f.Controls.Add($l1)
  $tDir = New-Object System.Windows.Forms.TextBox
  $tDir.Text = (Join-Path $env:ProgramFiles 'iflytek-sinkhole')
  $tDir.Location = '24,108'; $tDir.Size = '420,24'; $f.Controls.Add($tDir)
  $bDir = New-Object System.Windows.Forms.Button
  $bDir.Text = '浏览…'; $bDir.Location = '452,106'; $bDir.Size = '70,28'
  $bDir.Add_Click({ $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $tDir.Text = $d.SelectedPath } })
  $f.Controls.Add($bDir)

  # 数据
  $cData = New-Object System.Windows.Forms.CheckBox
  $cData.Text = '导入原机数据(文件列表 / 聊天记录 / 登录会话 / 身份组·流量配置 / 证书)——装完和源机一模一样'
  $cData.Location = '24,146'; $cData.Size = '500,24'; $cData.Checked = [bool]$hasData
  $cData.Enabled = [bool]$hasData
  if (-not $hasData) { $cData.Text = '导入原机数据(包内无 data.zip,不可用)' }
  $f.Controls.Add($cData)

  # 热点
  $cHot = New-Object System.Windows.Forms.CheckBox
  $cHot.Text = '装完自动开热点(hostednetwork);关掉则只做 DNS+中继(设备走路由器 DNS 指向本机)'
  $cHot.Location = '24,178'; $cHot.Size = '500,24'; $cHot.Checked = $true
  $f.Controls.Add($cHot)
  $l2 = New-Object System.Windows.Forms.Label
  $l2.Text = '热点 SSID:'; $l2.AutoSize = $true; $l2.Location = '40,210'; $f.Controls.Add($l2)
  $tSsid = New-Object System.Windows.Forms.TextBox
  $tSsid.Text = $ssid; $tSsid.Location = '120,207'; $tSsid.Size = '160,24'; $f.Controls.Add($tSsid)
  $l3 = New-Object System.Windows.Forms.Label
  $l3.Text = '密码(WPA2):'; $l3.AutoSize = $true; $l3.Location = '300,210'; $f.Controls.Add($l3)
  $tKey = New-Object System.Windows.Forms.TextBox
  $tKey.Text = $hkey; $tKey.Location = '380,207'; $tKey.Size = '142,24'; $f.Controls.Add($tKey)

  # 管理员账号
  $l4 = New-Object System.Windows.Forms.Label
  $l4.Text = '管理员账号:'; $l4.AutoSize = $true; $l4.Location = '24,246'; $f.Controls.Add($l4)
  $tUser = New-Object System.Windows.Forms.TextBox
  $tUser.Text = $user; $tUser.Location = '24,268'; $tUser.Size = '230,24'; $f.Controls.Add($tUser)
  $l5 = New-Object System.Windows.Forms.Label
  $l5.Text = '管理员密码(换机部署后建议改):'; $l5.AutoSize = $true; $l5.Location = '290,246'; $f.Controls.Add($l5)
  $tPass = New-Object System.Windows.Forms.TextBox
  $tPass.Text = $pass; $tPass.Location = '290,268'; $tPass.Size = '232,24'; $f.Controls.Add($tPass)

  $note = New-Object System.Windows.Forms.Label
  $note.Text = "提示: 目录/密码里别含 = 号。证书随包导入,设备上装过的 iflytek.cer 继续有效;`r`n不导入数据则 setup 会在本机重新生成新证书(设备需重装证书)。"
  $note.AutoSize = $true; $note.ForeColor = [System.Drawing.Color]::DarkSlateGray; $note.Location = '24,306'; $f.Controls.Add($note)

  $bGo = New-Object System.Windows.Forms.Button
  $bGo.Text = '开始安装 →'
  $bGo.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
  $bGo.BackColor = [System.Drawing.Color]::FromArgb(217, 79, 43)
  $bGo.ForeColor = [System.Drawing.Color]::White
  $bGo.FlatStyle = 'Flat'
  $bGo.Location = '24,356'; $bGo.Size = '300,44'
  $bGo.Add_Click({
    $dir = $tDir.Text.Trim()
    if (-not $dir) { [System.Windows.Forms.MessageBox]::Show('安装目录不能为空', '提示') | Out-Null; return }
    foreach ($v in @($dir, $tSsid.Text, $tKey.Text, $tUser.Text, $tPass.Text)) {
      if ($v -match "`r|`n|=") { [System.Windows.Forms.MessageBox]::Show('目录/SSID/密码/账号里不能有换行或 = 号', '提示') | Out-Null; return }
    }
    $lines = @(
      "DIR=$dir"
      "IMPORT=$(if ($cData.Checked) {'1'} else {'0'})"
      "HOT=$(if ($cHot.Checked) {'1'} else {'0'})"
      "SSID=$($tSsid.Text.Trim())"
      "HKEY=$($tKey.Text.Trim())"
      "USER=$($tUser.Text.Trim())"
      "PASS=$($tPass.Text)"
    )
    [IO.File]::WriteAllText($cfgPath, (($lines -join "`r`n") + "`r`n"), $gbk)
    $f.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $f.Close()
  })
  $f.Controls.Add($bGo)

  $bCancel = New-Object System.Windows.Forms.Button
  $bCancel.Text = '取消安装'
  $bCancel.Location = '354,356'; $bCancel.Size = '168,44'
  $bCancel.Add_Click({ $f.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $f.Close() })
  $f.Controls.Add($bCancel)

  $f.AcceptButton = $bGo
  $f.CancelButton = $bCancel
  if ($f.ShowDialog() -eq 'OK') { exit 0 }
  Remove-Item $cfgPath -Force -ErrorAction SilentlyContinue
  exit 1
}

# ================= Phase: Apply =================
$h = Read-Cfg
$hasZip = $Src -and (Test-Path (Join-Path $Src 'data.zip'))
if (-not $h.ContainsKey('IMPORT')) { $h['IMPORT'] = if ($hasZip) { '1' } else { '0' } } # 无 cfg(自动化)=有数据就克隆

$logLines = @()
function Note($t) { $script:logLines += $t }

# 目录优先级: install.cmd 传的 -Dst(权威) > cfg 的 DIR > 默认 —— SKIP_WIZARD 自动化时防旧残留 cfg 的 DIR 劫持
$dest = if ($Dst) { $Dst } else { if ($h['DIR']) { $h['DIR'] } else { $Dst } }
# 1) 导入数据(证书 + storage)
if ($h['IMPORT'] -eq '1' -and $hasZip) {
  Expand-Archive -Path (Join-Path $Src 'data.zip') -DestinationPath $dest -Force
  Note "已导入原机数据: 证书(指纹不变,设备无需重装) + storage\(文件/聊天/会话/身份组/流量)"
} elseif ($h['IMPORT'] -eq '1') {
  Note '勾了导入但包内无 data.zip —— 跳过(证书将在 setup 重新生成)'
} else {
  Note '未导入数据(全新库);证书随包已拷入 certs\,设备旧证书继续有效'
}

# 2) 应用向导里的配置项
$dst = $dest
$cfgFile = Join-Path $dst 'config.json'
if (Test-Path $cfgFile) {
  $cfg = Read-JsonUtf8 $cfgFile
  if ($cfg) {
    if (-not $cfg.relay) { $cfg | Add-Member relay ([PSCustomObject]@{}) -Force }
    if ($h.ContainsKey('HOT')) {
      $hot = [PSCustomObject]@{ enabled = ($h['HOT'] -eq '1') }
      if ($h['SSID']) { $hot | Add-Member ssid $h['SSID'] -Force }
      if ($h['HKEY']) { $hot | Add-Member key $h['HKEY'] -Force }
      $cfg.relay | Add-Member hotspot $hot -Force
      if ($h['SSID']) { Note "热点: ssid=$($h['SSID']) enabled=$($h['HOT'] -eq '1')" }
    }
    if ($h['USER'] -and $h.ContainsKey('PASS')) {
      if (-not $cfg.relay.auth) { $cfg.relay | Add-Member auth ([PSCustomObject]@{ enabled = $true; accounts = [PSCustomObject]@{}; roles = [PSCustomObject]@{} }) -Force }
      $acc = $cfg.relay.auth.accounts
      if (-not $acc) { $acc = [PSCustomObject]@{}; $cfg.relay.auth | Add-Member accounts $acc -Force }
      $acc | Add-Member -MemberType NoteProperty -Name $h['USER'] -Value $h['PASS'] -Force
      if (-not $cfg.relay.auth.roles) { $cfg.relay | Add-Member roles ([PSCustomObject]@{}) -Force }
      $roles = $cfg.relay.auth.roles
      if (-not ($roles.PSObject.Properties.Name -contains $h['USER'])) {
        $roleVal = if (@($acc.PSObject.Properties.Name).Count -le 1) { 'admin' } else { 'user' }
        $roles | Add-Member -MemberType NoteProperty -Name $h['USER'] -Value $roleVal -Force
      }
      Note "管理员账号: $($h['USER']) (角色 $(($roles.PSObject.Properties | Where-Object { $_.Name -eq $h['USER'] }).Value))"
    }
    Write-JsonUtf8 $cfgFile $cfg
    Note 'config.json 已按向导更新'
  }
}

# 3) 环境安装(setup: 证书(缺才生成)/防火墙/开机自启/启动服务/热点)
$setupRc = 'skipped'
if (-not $env:SKIP_SETUP) {
  $setupScript = Join-Path $dst 'setup-on-this-pc.ps1'
  if (Test-Path $setupScript) {
    $logDir = Join-Path $dst 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $arg = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $setupScript))
    if ($h['HOT'] -eq '0') { $arg += '-SkipHotspot' }
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -Wait -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'setup.out.log') -RedirectStandardError (Join-Path $logDir 'setup.err.log')
    $setupRc = "exit=$($p.ExitCode) (日志 logs\setup.out.log)"
    Note "setup-on-this-pc.ps1 $setupRc"
  } else { $setupRc = 'setup 脚本缺失'; Note "警告: $dst\setup-on-this-pc.ps1 不存在" }
} else { Note '按 SKIP_SETUP=1 跳过环境安装' }

# 4) 结果窗
$f2 = New-Object System.Windows.Forms.Form
$f2.Text = '安装完成 · iflytek 中继站'
$f2.Size = New-Object System.Drawing.Size(580, 430)
$f2.StartPosition = 'CenterScreen'
$f2.FormBorderStyle = 'FixedSingle'
$f2.MaximizeBox = $false
$f2.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$t2 = New-Object System.Windows.Forms.Label
$t2.Text = '✔ 安装完成'
$t2.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 15, [System.Drawing.FontStyle]::Bold)
$t2.ForeColor = [System.Drawing.Color]::FromArgb(31, 122, 77)
$t2.AutoSize = $true; $t2.Location = '22,16'; $f2.Controls.Add($t2)

$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true; $tb.ReadOnly = $true; $tb.ScrollBars = 'Vertical'
$tb.Location = '24,52'; $tb.Size = '520,170'
$ips = @()
try {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'vEthernet|Loopback|Bluetooth' } |
    ForEach-Object { "  $($_.IPAddress)  [$($_.InterfaceAlias)]" })
} catch {}
$tb.Text = (@("目标目录: $dst") + $logLines + @('本机 IP(DNS/设备指向它):') + $ips + @(
    '', '设备入口: 浏览器开 http://iflytek.com → 登录 → 中继站',
    "本机入口: 双击「中继站管理器.exe」或「打开中继站(管理员).cmd」",
    "卸载: $dst\uninstall-on-this-pc.ps1")) -join "`r`n"
$f2.Controls.Add($tb)

$mgr = Join-Path $dst '中继站管理器.exe'
$bMgr = New-Object System.Windows.Forms.Button
$bMgr.Text = '打开 管理器.exe'
$bMgr.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$bMgr.BackColor = [System.Drawing.Color]::FromArgb(217, 79, 43)
$bMgr.ForeColor = [System.Drawing.Color]::White
$bMgr.FlatStyle = 'Flat'
$bMgr.Location = '24,240'; $bMgr.Size = '250,46'
$bMgr.Enabled = (Test-Path $mgr)
$bMgr.Add_Click({ if (Test-Path $mgr) { Start-Process $mgr }; $f2.Close() })
$f2.Controls.Add($bMgr)

$bWeb = New-Object System.Windows.Forms.Button
$bWeb.Text = '打开 http://iflytek.com'
$bWeb.Location = '294,240'; $bWeb.Size = '250,46'
$bWeb.Add_Click({ Start-Process 'http://iflytek.com/relay'; $f2.Close() })
$f2.Controls.Add($bWeb)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = '服务已注册开机自启(计划任务 iflytek-sinkhole)。改配置用管理器.exe 里的「配置」。'
$hint.AutoSize = $true; $hint.ForeColor = [System.Drawing.Color]::Gray; $hint.Location = '24,300'; $f2.Controls.Add($hint)

if ($env:AUTO_EXIT) {
  # 自动化模式:不弹结果窗,结果走控制台
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  Write-Host ("目标目录: " + $dst)
  $logLines | ForEach-Object { Write-Host $_ }
  exit 0
}
$f2.Add_Shown({ $f2.Activate() })
$f2.ShowDialog() | Out-Null
exit 0
