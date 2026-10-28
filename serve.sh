#!/bin/bash
# Static server for twitch-sim — WebGPU needs a secure context (http://localhost counts).
# Named process: shows up as "twitch-sim-server" in ps args.
# NOTE: /usr/bin/python3 is an Xcode shim that re-execs and strips the argv[0]
# name, so we prefer the real framework binary directly.
PORT="${1:-8619}"
cd "$(dirname "$0")" || exit 1

PY=""
for cand in \
  "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python" \
  /usr/bin/python3 \
  python3; do
  if [ -x "$cand" ] || command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done

exec -a twitch-sim-server "$PY" -m http.server "$PORT" --bind 127.0.0.1
