#!/bin/sh
set -eu
cd /workspace
export FATHOMRAIL_PREVIEW=1
export FATHOMRAIL_OPEN=0
export HOST=0.0.0.0
export PORT=8080
exec python3 -m uvicorn fathomrail.server:app --host 0.0.0.0 --port 8080
