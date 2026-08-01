#!/usr/bin/env bash
set -euo pipefail

prefix="${OMNI_X264_PREFIX:?OMNI_X264_PREFIX is required}"

for argument in "$@"; do
  case "$argument" in
    --modversion)
      echo '0.164.3222'
      exit 0
      ;;
    --cflags)
      echo "-I$prefix/include"
      exit 0
      ;;
    --libs)
      echo "-L$prefix/lib -lx264 -lpthread -lm"
      exit 0
      ;;
    --variable=prefix)
      echo "$prefix"
      exit 0
      ;;
    --variable=includedir)
      echo "$prefix/include"
      exit 0
      ;;
  esac
done

# FFmpeg uses --exists/--atleast-version probes before requesting flags.
exit 0
