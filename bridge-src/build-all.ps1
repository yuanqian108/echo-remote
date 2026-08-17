# 交叉编译 bridge.zig 为 5 个平台目标(需要 Zig 0.14.1)
param(
  [string]$Zig = "D:\workspace\tools\zig\zig.exe"
)
$ErrorActionPreference = "Stop"
$src = "D:\workspace\echo-remote\bridge-src\bridge.zig"
$bin = "D:\workspace\echo-remote\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$targets = @(
  @{ name = 'bridge-x64';         target = 'x86_64-windows'    },
  @{ name = 'bridge-x64';         target = 'x86_64-linux-musl' },
  @{ name = 'bridge-arm64';       target = 'aarch64-linux-musl' },
  @{ name = 'bridge-macos-x64';   target = 'x86_64-macos'     },
  @{ name = 'bridge-macos-arm64'; target = 'aarch64-macos'    }
)
foreach ($t in $targets) {
  Write-Output ("building " + $t.name + " (" + $t.target + ")...")
  Push-Location $bin
  & $Zig build-exe $src -O ReleaseSmall -fstrip -target $t.target --name $t.name
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed: $($t.target)" }
  Pop-Location
}
Remove-Item (Join-Path $bin '*.o'),(Join-Path $bin '*.obj') -Force -ErrorAction SilentlyContinue
Get-ChildItem $bin | ForEach-Object { Write-Output ($_.Name + '  ' + $_.Length + ' bytes') }