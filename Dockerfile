# Sử dụng Python 3.11 slim làm base image
FROM python:3.11-slim

# Ngăn Python tạo bytecode .pyc và bật log unbuffered
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MASHLOOP_HOST=0.0.0.0 \
    MASHLOOP_PORT=8765 \
    MASHLOOP_DATA=/app/data \
    MASHLOOP_JS_RUNTIME=node

WORKDIR /app

# Cài đặt các gói hệ thống bắt buộc:
# - ffmpeg: xử lý và chuyển đổi âm thanh
# - nodejs 20+: yt-dlp cần JS runtime để vượt qua challenge của YouTube player
# - build-essential, pkg-config, libopus-dev: cần thiết để biên dịch sphn/audiopus trên kiến trúc ARM64 (Apple Silicon)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    ffmpeg \
    gnupg \
    build-essential \
    pkg-config \
    libopus-dev \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Nâng cấp pip
RUN pip install --no-cache-dir --upgrade pip

# Cài đặt PyTorch và Torchaudio
# Mặc định cài torch từ PyPI; nếu muốn dùng CUDA (cho Linux server có GPU NVIDIA),
# có thể build với: --build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124
ARG TORCH_VERSION=2.6.0
ARG TORCH_INDEX=""
RUN if [ -n "$TORCH_INDEX" ]; then \
        pip install --no-cache-dir "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" --index-url "${TORCH_INDEX}"; \
    else \
        pip install --no-cache-dir "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}"; \
    fi

# Cài beat-this và demucs với --no-deps để tránh ghi đè bản build torch
RUN pip install --no-cache-dir --no-deps beat-this demucs

# Cài đặt các thư viện Python còn lại (dùng bản tối ưu cho server từ deploy/requirements-server.txt)
COPY deploy/requirements-server.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy mã nguồn backend và frontend
COPY loopbox/ ./loopbox/
COPY web/ ./web/

# Tạo thư mục lưu trữ dữ liệu (bài hát tải về, cache phân tích, model weights)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8765

CMD ["python", "-m", "loopbox.server"]
