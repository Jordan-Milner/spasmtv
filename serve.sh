#!/bin/bash
# Static server for twitch-sim — WebGPU needs a secure context (http://localhost counts).
# Named process: shows up as "twitch-sim-server" in ps.
PORT="${1:-8619}"
cd "$(dirname "$0")" || exit 1
exec -a twitch-sim-server /usr/bin/python3 -m http.server "$PORT" --bind 127.0.0.1
