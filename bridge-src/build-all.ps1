# 交叉编译 Go 版桥接程序为 5 个平台目标(需要 Go 1.21+,无需目标平台工具链)
# 用法: .\build-all.ps1 [-Out <输出目录,默认 ..\bin>]
param(
  [string]$Out = "$PSScriptRoot\..\bin"
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Build([string]$name, [string]$goos, [string]$goarch, [string]$ext) {
  Write-Output ("building " + $name + " (" + $goos + "/" + $goarch + ")...")
  $env:CGO_ENABLED = "0"; $env:GOOS = $goos; $env:GOARCH = $goarch
  go build -trimpath -ldflags "-s -w" -o (Join-Path $Out ($name + $ext)) .
  if ($LASTEXITCODE -ne 0) { throw "build failed: $goos/$goarch" }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
Build "bridge-x64"         "windows" "amd64" ".exe"
Build "bridge-x64"         "linux"   "amd64" ""
Build "bridge-arm64"       "linux"   "arm64" ""
Build "bridge-macos-x64"   "darwin"  "amd64" ""
Build "bridge-macos-arm64" "darwin"  "arm64" ""

Write-Output ""
Get-ChildItem $Out | ForEach-Object { Write-Output ($_.Name + '  ' + $_.Length + ' bytes') }
