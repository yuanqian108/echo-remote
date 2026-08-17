# 打包 echo-remote 插件为 zip(排除开发目录)
param(
  [string]$OutDir = "D:\workspace\dist"
)
$ErrorActionPreference = "Stop"
$src = "D:\workspace\echo-remote"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$out = Join-Path $OutDir "echo-remote.zip"
if (Test-Path $out) { Remove-Item $out -Force }
# 只打包发布需要的文件
$files = @(
  "manifest.json",
  "index.js",
  "icon.svg",
  "README.md",
  "bin\bridge-x64.exe",
  "bin\bridge-x64",
  "bin\bridge-arm64",
  "bin\bridge-macos-x64",
  "bin\bridge-macos-arm64"
)
Compress-Archive -Path ($files | ForEach-Object { Join-Path $src $_ }) -DestinationPath $out -CompressionLevel Optimal
Write-Output "packaged: $out ($((Get-Item $out).Length) bytes)"
