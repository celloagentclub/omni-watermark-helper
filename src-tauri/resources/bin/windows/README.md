# Windows runtime

Run `npm run prepare:runtime:windows` from a Windows shell before building the
installer. Set `OMNI_FFMPEG_PATH` to a redistributable GPL FFmpeg build when no
suitable `ffmpeg.exe` is available on `PATH`. The script rejects builds that
contain `--enable-nonfree`. Generated binaries are intentionally not committed.
