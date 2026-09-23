#!/usr/bin/env bash
# 交叉编译 Go 版桥接程序为 5 个平台目标(需要 Go 1.21+,无需目标平台工具链)
# 用法: ./build-all.sh [输出目录,默认 ../bin]
set -euo pipefail
cd "$(dirname "$0")"

OUT="${1:-../bin}"
mkdir -p "$OUT"

build() {
  local name="$1" goos="$2" goarch="$3" ext="$4"
  echo "building $name ($goos/$goarch)..."
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w" -o "$OUT/$name$ext" .
}

build bridge-x64         windows amd64 ".exe"
build bridge-x64         linux   amd64 ""
build bridge-arm64       linux   arm64 ""
build bridge-macos-x64   darwin  amd64 ""
build bridge-macos-arm64 darwin  arm64 ""

echo
ls -l "$OUT"
