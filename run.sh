#!/usr/bin/env bash
# Khởi động Mash Loop trên http://127.0.0.1:8765 và mở trong trình duyệt.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT=8765

# Dừng tiến trình cũ nếu đang chiếm port 8765
OLD_PID=$(lsof -ti :$PORT || true)
if [ -n "$OLD_PID" ]; then
    echo "Stopping existing server on port $PORT (PID: $OLD_PID)..."
    kill -9 $OLD_PID 2>/dev/null || true
    sleep 0.8
fi

echo "Starting Mash ∞ Loop on http://127.0.0.1:$PORT..."
"$DIR/.venv/bin/python" -m loopbox.server --open "$@"
