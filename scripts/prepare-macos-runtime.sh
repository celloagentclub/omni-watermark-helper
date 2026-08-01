#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$project_root/src-tauri/resources/bin/macos"
app_runtime_dir="$project_root/src-tauri/resources/app-runtime"
node_source="$(command -v node)"

mkdir -p "$runtime_dir"
install -m 755 "$node_source" "$runtime_dir/node"
npm ci --prefix "$app_runtime_dir" --omit=dev

ffmpeg_target="$runtime_dir/ffmpeg"
if [[ -n "${OMNI_FFMPEG_PATH:-}" ]]; then
  if [[ ! -x "$OMNI_FFMPEG_PATH" ]]; then
    echo "OMNI_FFMPEG_PATH is not executable: $OMNI_FFMPEG_PATH" >&2
    exit 1
  fi
  install -m 755 "$OMNI_FFMPEG_PATH" "$ffmpeg_target"
fi

version=''
if [[ -x "$ffmpeg_target" ]]; then
  version="$("$ffmpeg_target" -version 2>&1 || true)"
fi
if [[ -z "$version" ]] || ! grep -q '^ffmpeg version ' <<<"$version" || grep -q -- '--enable-nonfree' <<<"$version"; then
  bash "$project_root/scripts/build-macos-ffmpeg.sh" "$ffmpeg_target"
  version="$("$ffmpeg_target" -version 2>&1)"
fi

encoders="$("$ffmpeg_target" -hide_banner -encoders 2>&1)"

if grep -q -- '--enable-nonfree' <<<"$version"; then
  echo 'The selected FFmpeg build contains --enable-nonfree and must not be distributed.' >&2
  exit 1
fi

if ! grep -Eq '(^|[[:space:]])libx264([[:space:]]|$)' <<<"$encoders"; then
  echo 'The selected FFmpeg build does not provide libx264.' >&2
  exit 1
fi

if ! grep -Eq '(^|[[:space:]])png([[:space:]]|$)' <<<"$encoders"; then
  echo 'The selected FFmpeg build does not provide the PNG encoder.' >&2
  exit 1
fi

echo "Prepared macOS runtime: $runtime_dir"
echo "Node: $("$runtime_dir/node" --version)"
printf '%s\n' "${version%%$'\n'*}"
