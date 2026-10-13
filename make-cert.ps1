# 生成 iflytek.com 的自签证书(含 SAN),导出:
#   certs/iflytek.pfx  -> 本服务 HTTPS 使用(带口令,口令与 config.json 一致)
#   certs/iflytek.cer  -> 分发给局域网设备安装"受信任的根",免浏览器警告
$ErrorActionPreference = 'Stop'
$domain     = 'iflytek.com'
$passPlain  = (Get-Content -Raw -Encoding UTF8 -Path (Join-Path $PSScriptRoot 'config.json') | ConvertFrom-Json).cert.passphrase
$certsDir   = Join-Path $PSScriptRoot 'certs'
if (-not (Test-Path $certsDir)) { New-Item -ItemType Directory -Path $certsDir | Out-Null }
$secure     = ConvertTo-SecureString -String $passPlain -Force -AsPlainText

# 清理旧的 sinkhole 证书(含改名前留下的 sinkhole-iflaytek.com)
Get-ChildItem "Cert:\CurrentUser\My" | Where-Object { $_.FriendlyName -in @("sinkhole-$domain", 'sinkhole-iflaytek.com') } | Remove-Item -Force

$cert = New-SelfSignedCertificate `
  -DnsName @($domain, "*.$domain") `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -FriendlyName "sinkhole-$domain" `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' `
  -NotAfter (Get-Date).AddYears(5)

Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath (Join-Path $certsDir 'iflytek.pfx') -Password $secure | Out-Null
Export-Certificate   -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath (Join-Path $certsDir 'iflytek.cer') | Out-Null

Write-Host "已生成:"
Write-Host "  PFX: $certsDir\iflytek.pfx (指纹 $($cert.Thumbprint), 有效期至 $($cert.NotAfter))"
Write-Host "  CER: $certsDir\iflytek.cer (给局域网设备装信任用)"
