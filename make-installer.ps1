# =====================================================================
#  make-installer.ps1 —— 一键打包 IExpress 安装包(带安装向导 + 管理器 exe)
#  产物: dist\iflytek-sinkhole-setup.exe
#        双击 → 解压 → UAC 提权 → 【安装向导窗】(目录/导入数据/热点/管理员账号)
#        → 铺文件 → 应用配置 → setup-on-this-pc.ps1 → 结果窗(打开 管理器.exe / 门户)
#  包内自带 中继站管理器.exe(编译的 WinExe 壳,点开=可视化 启停服务/状态灯/热点/配置)
#  载荷 = 根目录全部文件 + public\*.html + certs\*.pfx/*.cer + data.zip(storage 数据) + node.exe
#  用法: .\make-installer.ps1             捆绑 runtime\node.exe + storage 数据(推荐)
#        .\make-installer.ps1 -NoRuntime  不捆 Node(新机器安装时 setup -BundleRuntime 下载)
#        .\make-installer.ps1 -NoData     不打包 storage 数据(装成全新空库)
#        .\make-installer.ps1 -KeepStaging 保留中间目录便于排查
#  已知约束(实测得出):
#   - IExpress /N 不吃带引号的路径 → 构建目录无空格(TEMP 含空格则回退 C:\iflytek-si-build)
#   - SED 必须 GBK(936) 编码 → 只能在中文 Windows 构建;中文文件名可用(实测通过)
#   - IExpress 解压拍平子目录 → install.cmd(GBK)按扩展名重建 public\certs\storage\runtime
#   - install.cmd 必须 CRLF 换行(LF-only 会被 cmd 解析成碎行)
#  安装期环境变量(自动化测试):
#     SKIP_WIZARD=1  不弹向导(默认导入 data.zip,不改配置)
#     AUTO_EXIT=1    不弹向导/结果窗/不 pause(结果走控制台)
#     SKIP_SETUP=1   跳过 setup-on-this-pc.ps1
#     INSTALL_DIR=目录  无向导时的默认安装目录(有向导时以向导里填的为准)
# =====================================================================
param([switch]$NoRuntime, [switch]$NoData, [switch]$KeepStaging)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function OK($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }

# ---------- 0) 构建目录(必须无空格) ----------
$staging = Join-Path $env:TEMP 'iflytek-si-build'
if ($staging -match '\s') { $staging = "$env:SystemDrive\iflytek-si-build" }
if ($staging -match '\s') { throw "构建路径含空格且无可用回退:TEMP=$env:TEMP" }
Step "准备暂存目录 $staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
OK '暂存目录就绪'

# ---------- 1) 收集载荷(拍平) ----------
Step '收集部署文件'
$rootFiles = Get-ChildItem $root -File
if (-not ($rootFiles.Name -contains 'index.js')) { throw 'index.js 缺失,请在项目根目录运行' }
Copy-Item -Path $rootFiles.FullName -Destination $staging
if (-not (Test-Path (Join-Path $root 'public\index.html'))) { throw 'public\index.html 缺失,部署包不完整' }
Copy-Item (Join-Path $root 'public\*.html') $staging
# 证书:私钥 pfx + 设备信任 cer 都随包 → 装完指纹不变,设备上已装的 iflytek.cer 继续有效
$gotCert = $false
foreach ($ext in 'pfx', 'cer') {
  $p = Join-Path $root "certs\iflytek.$ext"
  if (Test-Path $p) { Copy-Item $p $staging; $gotCert = $true }
}
if (-not $gotCert) { Warn 'certs\ 缺失:包内无证书 → 装完 setup 会重新生成新证书(设备需重装 cer)' }
# storage 数据 zip(文件/聊天/会话/身份组/流量)
$dataZip = Join-Path $staging 'data.zip'
if ($NoData) { Warn '按 -NoData 不打包 storage 数据(装成全新空库)' }
elseif (Test-Path (Join-Path $root 'storage')) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $layout = Join-Path $env:TEMP ('iflytek-data-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path "$layout\storage" | Out-Null
  Copy-Item (Join-Path $root 'storage\*') "$layout\storage" -Recurse -Force
  [IO.Compression.ZipFile]::CreateFromDirectory($layout, $dataZip, 'Optimal', $false)
  Remove-Item $layout -Recurse -Force
  $n = (Get-ChildItem (Join-Path $root 'storage') -Recurse -File).Count
  OK "storage 数据已打包 data.zip ($n 个文件)"
} else { Warn 'storage\ 不存在:无数据可打包' }
# Node
if ($NoRuntime) { Warn '按 -NoRuntime 不捆绑 Node' }
else {
  $rtNode = Join-Path $root 'runtime\node.exe'
  if (Test-Path $rtNode) { Copy-Item $rtNode $staging; OK "捆绑便携 Node ($([int]((Get-Item $rtNode).Length / 1MB)) MB)" }
  else { Warn 'runtime\node.exe 不存在:新机器用 setup -BundleRuntime 下载' }
}

# ---------- 2) 编译 中继站管理器.exe(WinExe 壳 → 跑 launcher.ps1 GUI,零第三方依赖) ----------
Step '编译 中继站管理器.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "未找到 csc.exe(.NET Framework 自带): $csc" }
$stubSrc = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
static class Stub {
  [STAThread]
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string ps1 = Path.Combine(dir, "launcher.ps1");
    if (!File.Exists(ps1)) {
      MessageBox.Show("launcher.ps1 missing:\n" + ps1, "iflytek relay", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return 2;
    }
    string a = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"";
    foreach (string x in args) {
      bool q = x.Length == 0 || x.IndexOfAny(new char[] { ' ', '"' }) >= 0;
      a += q ? (" \"" + x.Replace("\"", "\\\"") + "\"") : (" " + x);
    }
    try {
      var p = new Process();
      p.StartInfo = new ProcessStartInfo("powershell.exe", a);
      p.StartInfo.WorkingDirectory = dir;
      p.StartInfo.UseShellExecute = false;
      p.Start();
      p.WaitForExit();
      return p.ExitCode;
    } catch (Exception e) { MessageBox.Show(e.Message, "launcher fail"); return 1; }
  }
}
'@
# 写纯 ASCII 源(编码安全),输出 ASCII 名再改中文名(避免 csc 命令行编码问题)
$stubPath = Join-Path $staging 'launcher-stub.cs'
[IO.File]::WriteAllText($stubPath, $stubSrc, [Text.Encoding]::ASCII)
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/out:launcher-stub.exe', 'launcher-stub.cs')
$cp = Start-Process -FilePath $csc -ArgumentList $cscArgs -WorkingDirectory $staging -Wait -PassThru -WindowStyle Hidden
if ($cp.ExitCode -ne 0 -or -not (Test-Path (Join-Path $staging 'launcher-stub.exe'))) { throw "csc 编译失败 exit=$($cp.ExitCode)" }
Move-Item (Join-Path $staging 'launcher-stub.exe') (Join-Path $staging ([char]0x4E2D + '继站管理器.exe')) -Force
Remove-Item $stubPath -Force
OK '中继站管理器.exe 已编译(WinExe,无控制台闪烁)'

# ---------- 3) 生成 install.cmd(GBK + CRLF;向导两阶段 + 目录重建) ----------
Step '生成 install.cmd'
$installCmd = @'
@echo off
rem iflytek-sinkhole installer (generated by make-installer.ps1)
chcp 936 >nul 2>&1
title iflytek-sinkhole Setup
setlocal EnableExtensions
set "SRC=%~dp0"
if defined ELEVATED goto main
net session >nul 2>&1
if errorlevel 1 goto elevate

:main
echo.
echo [1/4] 安装向导...
if defined SKIP_WIZARD goto wizskip
powershell -NoProfile -ExecutionPolicy Bypass -File "%SRC%setup-wizard.ps1" -Phase Ask -Src "%SRC:~0,-1%"
if errorlevel 1 goto cancelled
goto wizdone
:wizskip
echo     SKIP_WIZARD=1 已跳过向导,默认导入包内数据
if defined INSTALL_DIR goto wizdone
if not exist "%TEMP%\iflytek-setup.cfg" goto wizdone
:wizdone
set "DST=%ProgramFiles%\iflytek-sinkhole"
if defined INSTALL_DIR set "DST=%INSTALL_DIR%"
rem 向导刚跑完时用它的 DIR;SKIP_WIZARD 自动化不读旧残留 cfg(防覆盖 INSTALL_DIR)
if defined SKIP_WIZARD goto noreadcfg
if exist "%TEMP%\iflytek-setup.cfg" (
  for /f "usebackq tokens=1,* delims==" %%a in ("%TEMP%\iflytek-setup.cfg") do (
    if /i "%%a"=="DIR" if not "%%b"=="" set "DST=%%b"
  )
)
:noreadcfg
echo [2/4] 安装目录: %DST%
if not exist "%DST%" mkdir "%DST%"
for %%d in (public certs runtime logs storage) do if not exist "%DST%\%%d" mkdir "%DST%\%%d"
echo [3/4] 复制文件...
copy /y "%SRC%*.js" "%DST%\" >nul
copy /y "%SRC%*.ps1" "%DST%\" >nul
copy /y "%SRC%*.json" "%DST%\" >nul
copy /y "%SRC%*.md" "%DST%\" >nul
copy /y "%SRC%*.xml" "%DST%\" >nul
if exist "%SRC%*.html" copy /y "%SRC%*.html" "%DST%\public\" >nul
if exist "%SRC%*.cer" copy /y "%SRC%*.cer" "%DST%\certs\" >nul
if exist "%SRC%*.pfx" copy /y "%SRC%*.pfx" "%DST%\certs\" >nul
if exist "%SRC%node.exe" copy /y "%SRC%node.exe" "%DST%\runtime\" >nul
if exist "%SRC%data.zip" copy /y "%SRC%data.zip" "%DST%\" >nul
if exist "%SRC%.gitignore" copy /y "%SRC%.gitignore" "%DST%\" >nul
for %%f in ("%SRC%*.cmd") do if /i not "%%~nxf"=="install.cmd" copy /y "%%~f" "%DST%\" >nul
for %%f in ("%SRC%*.exe") do copy /y "%%~f" "%DST%\" >nul
if not exist "%DST%\index.js" goto copyfail
if not exist "%DST%\public\index.html" goto copyfail
if not exist "%DST%\setup-wizard.ps1" goto copyfail
echo     校验通过: index.js / public\index.html / setup-wizard.ps1
echo [4/4] 应用配置 + 环境安装 setup
powershell -NoProfile -ExecutionPolicy Bypass -File "%DST%\setup-wizard.ps1" -Phase Apply -Src "%SRC:~0,-1%" -Dst "%DST%"
set WRC=%errorlevel%
if not %WRC%==0 goto applyfail
echo.
echo     安装完成: %DST%
set RC=0
goto fin

:copyfail
echo [失败] 关键文件没复制到位(安装目录不可写,或安装包损坏)。请用管理员身份重跑。
set RC=1
goto fin

:applyfail
echo [失败] 向导 Apply 阶段 exit=%WRC%,安装未完成。看上方 setup 输出与 DST\logs\setup.out.log
set RC=1
goto fin

:elevate
set ELEVATED=1
echo 需要管理员权限,弹出 UAC 后请点「是」...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"
if errorlevel 1 goto cancelled
exit /b

:cancelled
echo.
echo 已取消,安装未完成。
if not defined AUTO_EXIT pause
exit /b 1

:fin
echo.
if not defined AUTO_EXIT pause
exit /b %RC%
'@
$installCmd = ($installCmd -replace "`r`n", "`n") -replace "`n", "`r`n"  # cmd.exe 必须 CRLF
[IO.File]::WriteAllText((Join-Path $staging 'install.cmd'), $installCmd, [Text.Encoding]::GetEncoding(936))
OK 'install.cmd 已生成(GBK+CRLF)'

# ---------- 4) 生成 SED(GBK;先枚举清单) ----------
Step '生成 SED 指令文件'
$exePath = Join-Path $staging 'iflytek-sinkhole-setup.exe'
$sedLines = @(
  '[Version]', 'Class=IEXPRESS', 'SEDVersion=3.0',
  '[Options]',
  'PackagePurpose=InstallApp',
  'ShowInstallProgramWindow=1',
  'HideExtractAnimation=0',
  'UseLongFileName=1',
  'InsideCompressed=1',
  'CAB_FixedSize=0',
  'RebootMode=N',
  'InstallPrompt=',
  'DisplayLicense=',
  'FinishMessage=',
  "TargetName=$exePath",
  'FriendlyName=iflytek-sinkhole Setup',
  'AppLaunched=install.cmd',
  'PostInstallCmd=<None>',
  'AdminQuietInstCmd=',
  'UserQuietInstCmd=',
  'SourceFiles=SourceFiles',
  '',
  '[Strings]'
)
$payload = Get-ChildItem $staging -File | Sort-Object Name
for ($i = 0; $i -lt $payload.Count; $i++) { $sedLines += ('FILE{0}="{1}"' -f $i, $payload[$i].Name) }
$sedLines += ''
$sedLines += '[SourceFiles]'
$sedLines += "SourceFiles0=$staging\"
$sedLines += '[SourceFiles0]'
for ($i = 0; $i -lt $payload.Count; $i++) { $sedLines += ('%FILE{0}%=' -f $i) }
$sedPath = Join-Path $staging 'build.sed'
[IO.File]::WriteAllText($sedPath, ($sedLines -join "`r`n") + "`r`n", [Text.Encoding]::GetEncoding(936))
OK "SED 已生成($($payload.Count) 个文件): $sedPath"

# ---------- 5) IExpress 构建 ----------
Step 'IExpress 构建中(捆绑 node.exe 时压缩 99MB 需 1~3 分钟)'
$ix = Join-Path $env:WINDIR 'System32\iexpress.exe'
if (-not (Test-Path $ix)) { throw "未找到 iexpress.exe: $ix" }
$proc = Start-Process -FilePath $ix -ArgumentList "/N $sedPath" -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddMinutes(15)
$sec = 0
while (-not $proc.HasExited -and -not (Test-Path $exePath) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  $sec++
  if ($sec % 30 -eq 0) { Write-Host "  ...构建中 ($sec 秒)" -ForegroundColor DarkGray }
}
if (-not (Test-Path $exePath)) {
  if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
  throw "IExpress 构建失败或超时。SED 保留: $sedPath"
}
for ($k = 0; $k -lt 60 -and -not $proc.HasExited; $k++) { Start-Sleep -Milliseconds 500 }
if (-not $proc.HasExited) { try { $proc.Kill() } catch {} }
$size = (Get-Item $exePath).Length
OK "构建完成: $exePath ($([math]::Round($size / 1MB, 1)) MB, 用时 $sec 秒)"

# ---------- 6) 输出 dist ----------
Step '输出 dist\'
$dist = Join-Path $root 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }
$final = Join-Path $dist 'iflytek-sinkhole-setup.exe'
Copy-Item $exePath $final -Force
if (-not $NoRuntime -and $size -lt 10MB) { Warn '成品 <10MB:确认 node.exe 打进去了' }
if ($KeepStaging) { Warn "暂存目录保留: $staging" }
else { Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host "  安装包: $final" -ForegroundColor Green
Write-Host "  大小:   $([math]::Round((Get-Item $final).Length / 1MB, 1)) MB" -ForegroundColor Green
Write-Host '  双击 → UAC → 向导窗(目录/数据/热点/账号) → 自动装;装完结果页可直接开 管理器.exe' -ForegroundColor Cyan
Write-Host '  测试: SKIP_WIZARD=1 AUTO_EXIT=1 SKIP_SETUP=1 INSTALL_DIR=目录' -ForegroundColor Cyan
Write-Host ''
