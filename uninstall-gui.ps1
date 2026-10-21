# =====================================================================
#  uninstall-gui.ps1 —— 一键卸载向导(被 卸载中继站.exe 调用,也可直接跑)
#  动作清单(与 uninstall-on-this-pc.ps1 命令行版一致,可勾选):
#    ① 停服务 + 删三个计划任务(iflytek-sinkhole/sinkhole-hotspot/sinkhole-keepalive)
#      —— 漏删 keepalive 的旧 bug:每 5 分钟把已删服务反复拉起
#    ② 删 4 条防火墙规则(Sinkhole-DNS-UDP/TCP, Sinkhole-Web-TCP/TLS)
#    ③ 杀所有 --svc-sinkhole 进程(含避让到 28792+ 的残留实例)
#    ④ 可选:停热点广播 / 删本机证书存储条目
#  默认【不删】文件:storage(你的数据)、certs、config.json 全部保留,提示手动删目录
#  参数: -ProbeFile <path> 自动化冒烟(开窗即写标记退出,不执行卸载)
# =====================================================================
param([string]$ProbeFile = '')
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$root = $PSScriptRoot
$domain = 'iflytek.com'
try {
  $c = [IO.File]::ReadAllText((Join-Path $root 'config.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  if ($c.sinkholeDomain) { $domain = $c.sinkholeDomain }
} catch {}

$TASKS = @('iflytek-sinkhole', 'sinkhole-hotspot', 'sinkhole-keepalive')
$FWRULES = @('Sinkhole-DNS-UDP', 'Sinkhole-DNS-TCP', 'Sinkhole-Web-TCP', 'Sinkhole-Web-TLS')

function Invoke-Uninstall([bool]$stopHot, [bool]$rmCert, [string]$logPath) {
  # 返回日志行数组;每步独立 try,单步失败不中断其余步骤
  $L = @()
  $L += "开始卸载 @ $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  try { $L += ("停止服务实例: " + @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*--svc-sinkhole*' }).Count + " 个") } catch {}
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
    Where-Object { $_.CommandLine -like '*--svc-sinkhole*' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -EA Stop; $L += "  已停 pid $($_.ProcessId)" } catch { $L += "  停 pid $($_.ProcessId) 失败" } }
  foreach ($t in $TASKS) {
    try {
      $tk = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
      if ($tk) { Stop-ScheduledTask -TaskName $t -EA SilentlyContinue; Unregister-ScheduledTask -TaskName $t -Confirm:$false -EA Stop; $L += "已删计划任务: $t" }
      else { $L += "计划任务不存在(跳过): $t" }
    } catch { $L += "计划任务 $t 删除失败: $($_.Exception.Message)" }
  }
  foreach ($r in $FWRULES) {
    try { $o = netsh advfirewall firewall delete rule name="$r" 2>&1 | Out-String; if ($o -match 'Deleted|已删除|没有找到规则|No rules') { $L += "防火墙规则 $r : 已处理" } else { $L += "防火墙规则 $r : $((($o -split "`r?`n") | Where-Object {$_}) -join ' ')" } } catch { $L += "防火墙规则 $r 失败" }
  }
  if ($stopHot) {
    try {
      $hs = netsh wlan show hostednetwork 2>&1 | Out-String
      if ($hs -match 'Status\s*:\s*Started') { netsh wlan stop hostednetwork 2>&1 | Out-Null; $L += '热点广播: 已停止' } else { $L += '热点广播: 本就未开(跳过)' }
    } catch { $L += '热点停止失败(不影响卸载)' }
  }
  if ($rmCert) {
    try {
      $n = 0
      Get-ChildItem "Cert:\CurrentUser\My" -EA SilentlyContinue | Where-Object { $_.FriendlyName -like "sinkhole-*" } | ForEach-Object { Remove-Item $_.PSPath -Force -EA SilentlyContinue; $n++ }
      $L += "本机证书存储 sinkhole-* 条目: 删了 $n 个(设备上已装的信任证书不受影响,要清去设备上手动卸)"
    } catch { $L += "证书清理失败: $($_.Exception.Message)" }
  }
  $L += '完成。文件未删除:storage\(数据) certs\ config.json 全部保留;要彻底清除请手动删除安装目录。'
  $L += '另:若路由器/光猫 DHCP 曾把 DNS 指向本机,记得改回原值,否则设备会断网!'
  try { if ($logPath) { [IO.File]::AppendAllText($logPath, (($L -join "`r`n") + "`r`n`r`n"), [Text.UTF8Encoding]::new($true)) } } catch {}
  return $L
}

# ---------------- 图形界面 ----------------
$f = New-Object System.Windows.Forms.Form
$f.Text = '卸载 · iflytek 中继站'
$f.Size = New-Object System.Drawing.Size(600, 560)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedSingle'
$f.MaximizeBox = $false
$f.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$t1 = New-Object System.Windows.Forms.Label
$t1.Text = '一键卸载(与安装向导对称)'
$t1.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)
$t1.AutoSize = $true; $t1.Location = '20,18'; $f.Controls.Add($t1)

$t2 = New-Object System.Windows.Forms.Label
$t2.Text = "服务目录: $root"
$t2.AutoSize = $true; $t2.ForeColor = [System.Drawing.Color]::Gray; $t2.Location = '24,50'; $f.Controls.Add($t2)

$plan = New-Object System.Windows.Forms.TextBox
$plan.Multiline = $true; $plan.ReadOnly = $true; $plan.ScrollBars = 'Vertical'
$plan.Location = '20,76'; $plan.Size = '546,190'
$plan.Font = New-Object System.Drawing.Font('Consolas', 9)
$plan.Text = @"
将执行:
 [1] 停止中继站服务进程(含 28792+ 避让残留实例)
 [2] 删除 3 个计划任务: iflytek-sinkhole / sinkhole-hotspot / sinkhole-keepalive
     (旧版只删第 1 个 → keepalive 每 5 分钟把已删服务复活,已修)
 [3] 删除 4 条防火墙规则(Sinkhole-DNS-UDP/TCP, Web-TCP/TLS)
 [4] (可选)停止热点广播 / 清理本机证书存储条目

不会动:
 · storage\ 你的文件/聊天/身份组/流量     —— 想删自己删
 · certs\ 证书、config.json 配置          —— 留着,重装可复用
 · 设备上已装的 iflytek.cer 信任          —— 不受影响
⚠ 路由器/光猫 DHCP 若曾把 DNS 指向本机 → 卸载后改回,否则设备断网
"@
$f.Controls.Add($plan)

$ckHot = New-Object System.Windows.Forms.CheckBox
$ckHot.Text = '同时停止热点广播(开过热点就勾上)'; $ckHot.AutoSize = $true; $ckHot.Checked = $true; $ckHot.Location = '24,280'; $f.Controls.Add($ckHot)

$ckCert = New-Object System.Windows.Forms.CheckBox
$ckCert.Text = "清理本机证书存储里的 sinkhole-$domain 条目(可选)"; $ckCert.AutoSize = $true; $ckCert.Checked = $false; $ckCert.Location = '24,308'; $f.Controls.Add($ckCert)

$result = New-Object System.Windows.Forms.TextBox
$result.Multiline = $true; $result.ReadOnly = $true; $result.ScrollBars = 'Vertical'
$result.Location = '20,342'; $result.Size = '546,120'
$result.Font = New-Object System.Drawing.Font('Consolas', 9)
$result.Visible = $false; $f.Controls.Add($result)

function After-Ok($lines) {
  $plan.Visible = $false; $ckHot.Visible = $false; $ckCert.Visible = $false
  $result.Visible = $true; $result.Text = ($lines -join "`r`n"); $result.SelectionStart = 0
  $btnGo.Visible = $false; $btnCancel.Text = '关闭'
  [System.Windows.Forms.MessageBox]::Show('卸载完成(文件与数据均保留,见下方日志)', '完成') | Out-Null
}

$btnGo = New-Object System.Windows.Forms.Button
$btnGo.Text = '执行卸载'
$btnGo.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$btnGo.BackColor = [System.Drawing.Color]::FromArgb(217, 79, 43); $btnGo.ForeColor = [System.Drawing.Color]::White
$btnGo.FlatStyle = 'Flat'; $btnGo.Location = '20,474'; $btnGo.Size = '270,46'
$btnGo.Add_Click({
    $yes = [System.Windows.Forms.MessageBox]::Show('确定卸载?服务/计划任务/防火墙将被移除(文件数据保留)。', '确认卸载', 'YesNo', 'Warning')
    if ($yes -ne 'Yes') { return }
    $btnGo.Enabled = $false; $f.Refresh()
    $lines = Invoke-Uninstall $ckHot.Checked $ckCert.Checked (Join-Path $root 'logs\uninstall.log')
    After-Ok $lines
  })
$f.Controls.Add($btnGo)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = '取消'; $btnCancel.Location = '316,474'; $btnCancel.Size = '250,46'
$btnCancel.Add_Click({ $f.Close() })
$f.Controls.Add($btnCancel)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = '需管理员权限(本 exe 已内置);日志另存 logs\uninstall.log'
$hint.AutoSize = $true; $hint.ForeColor = [System.Drawing.Color]::Gray; $hint.Location = '24,524'; $f.Controls.Add($hint)

if ($ProbeFile) {
  $f.ShowInTaskbar = $false
  $f.Add_Shown({
    Start-Sleep -Milliseconds 600
    try { [IO.File]::WriteAllText($ProbeFile, "uninit=ok;window=shown;tasks=$($TASKS.Count);rules=$($FWRULES.Count);root=$root", [Text.UTF8Encoding]::new($false)) } catch {}
    $f.Close()
  })
}
$f.ShowDialog() | Out-Null
exit 0
