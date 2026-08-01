#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo 'This build script currently supports Apple Silicon macOS only.' >&2
  exit 1
fi

for tool in clang make shasum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing build dependency: $tool" >&2
    exit 1
  fi
done

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
third_party="$project_root/src-tauri/resources/third-party"
ffmpeg_archive="$third_party/ffmpeg/ffmpeg-8.1.2.tar.xz"
x264_archive="$third_party/x264/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.gz"
output_path="${1:-$project_root/src-tauri/resources/bin/macos/ffmpeg}"
build_root="$(mktemp -d "${TMPDIR:-/tmp}/omni-ffmpeg-build.XXXXXX")"
prefix="$build_root/prefix"
pkg_config_x264="$build_root/pkg-config-x264"
jobs="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"

cleanup() {
  rm -rf "$build_root"
}
trap cleanup EXIT

printf '%s  %s\n' \
  '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c' \
  "$ffmpeg_archive" | shasum -a 256 -c -
printf '%s  %s\n' \
  'cd71a7515b0e9a012e1ac9b1f8415bebcaf6fc97d4db32286642ac4c0fbe24f9' \
  "$x264_archive" | shasum -a 256 -c -

mkdir -p "$prefix"
install -m 755 "$project_root/scripts/pkg-config-x264.sh" "$pkg_config_x264"
tar -xf "$ffmpeg_archive" -C "$build_root"
tar -xzf "$x264_archive" -C "$build_root"

x264_source="$build_root/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
ffmpeg_source="$build_root/ffmpeg-8.1.2"

pushd "$x264_source" >/dev/null
CC=clang ./configure \
  --prefix="$prefix" \
  --host="$(clang -dumpmachine)" \
  --enable-static \
  --enable-pic \
  --disable-cli \
  --disable-opencl
make -j"$jobs"
make install
popd >/dev/null

pushd "$ffmpeg_source" >/dev/null
OMNI_X264_PREFIX="$prefix" ./configure \
  --prefix="$prefix" \
  --arch=arm64 \
  --target-os=darwin \
  --cc=clang \
  --pkg-config="$pkg_config_x264" \
  --pkg-config-flags=--static \
  --disable-autodetect \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --disable-ffprobe \
  --disable-avdevice \
  --enable-gpl \
  --enable-libx264 \
  --enable-zlib \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-neon \
  --enable-static \
  --disable-shared
make -j"$jobs" ffmpeg
popd >/dev/null

mkdir -p "$(dirname "$output_path")"
install -m 755 "$ffmpeg_source/ffmpeg" "$output_path"
echo "Built redistributable FFmpeg: $output_path"
