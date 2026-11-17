#!/usr/bin/env bash
# Build native/windows/kaleidosync-wasapi.exe.
#
# The helper is plain C (WASAPI + process loopback) and is committed as a
# prebuilt binary so Windows users need no toolchain. Rebuild it when
# kaleidosync-wasapi.c changes.
#
# Cross-compiling from Linux (the usual path, and what CI does):
#   sudo apt-get install gcc-mingw-w64-x86-64
#   npm run build:native
#
# Building on Windows instead (MSVC is not used; install mingw-w64 and set
# CROSS=gcc):
#   CROSS=gcc npm run build:native
set -euo pipefail
cd "$(dirname "$0")"

CROSS="${CROSS:-x86_64-w64-mingw32-gcc}"

if ! command -v "$CROSS" >/dev/null 2>&1; then
  echo "error: $CROSS not found." >&2
  echo "install it (Debian/Ubuntu: apt-get install gcc-mingw-w64-x86-64) or set CROSS=<compiler>." >&2
  exit 1
fi

"$CROSS" -O2 -Wall -Wextra -static-libgcc -static-libstdc++ \
  -o kaleidosync-wasapi.exe kaleidosync-wasapi.c \
  -lole32 -lmmdevapi -lpropsys -luuid

echo "built $(pwd)/kaleidosync-wasapi.exe"

# Sanity check: the exe must import only system DLLs so it runs on a stock
# Windows install without a redistributable.
if command -v x86_64-w64-mingw32-objdump >/dev/null 2>&1; then
  x86_64-w64-mingw32-objdump -p kaleidosync-wasapi.exe | grep -i "DLL Name" || true
fi