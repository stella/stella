# Pin the complete multi-architecture manifest for Python 3.12 slim Bookworm.
# PaddlePaddle's CUDA 12.6 wheel is currently published for amd64 Linux only;
# the build guard below rejects an architecture that cannot run it.
FROM python:3.14-slim-bookworm@sha256:23c59390fc717bf09f9336908199a0ae75d9c4264bf296123f94ad772fea3b52 AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.2@sha256:069a51314a7bb6031777a9273205fe1b0b19e914ef418207d1338b268df641dd /uv /uvx /bin/

ARG TARGETARCH
ARG TEXT_DETECTION_MODEL_URL=https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_infer.tar
ARG TEXT_DETECTION_MODEL_SHA256=144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7
ARG TEXT_RECOGNITION_MODEL_URL=https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_infer.tar
ARG TEXT_RECOGNITION_MODEL_SHA256=4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/stella/venv \
    UV_PYTHON_DOWNLOADS=never \
    VIRTUAL_ENV=/opt/stella/venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

RUN test "${TARGETARCH}" = "amd64"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/ocr-service
COPY apps/ocr-service/pyproject.toml apps/ocr-service/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

RUN set -eux; \
    mkdir -p /tmp/models /opt/stella/models; \
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output /tmp/models/text-detection.tar \
      "${TEXT_DETECTION_MODEL_URL}"; \
    printf '%s  %s\n' \
      "${TEXT_DETECTION_MODEL_SHA256}" \
      /tmp/models/text-detection.tar \
      | sha256sum --check --strict -; \
    tar --extract --file /tmp/models/text-detection.tar --directory /tmp/models; \
    test -d /tmp/models/PP-OCRv6_medium_det_infer; \
    mv /tmp/models/PP-OCRv6_medium_det_infer \
      /opt/stella/models/text-detection; \
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output /tmp/models/text-recognition.tar \
      "${TEXT_RECOGNITION_MODEL_URL}"; \
    printf '%s  %s\n' \
      "${TEXT_RECOGNITION_MODEL_SHA256}" \
      /tmp/models/text-recognition.tar \
      | sha256sum --check --strict -; \
    tar --extract --file /tmp/models/text-recognition.tar --directory /tmp/models; \
    test -d /tmp/models/PP-OCRv6_medium_rec_infer; \
    mv /tmp/models/PP-OCRv6_medium_rec_infer \
      /opt/stella/models/text-recognition; \
    rm -rf \
      /tmp/models

FROM python:3.14-slim-bookworm@sha256:23c59390fc717bf09f9336908199a0ae75d9c4264bf296123f94ad772fea3b52 AS runtime

ENV HOME=/tmp/stella/home \
    HF_HUB_OFFLINE=1 \
    PADDLE_PDX_CACHE_HOME=/tmp/stella/paddlex-cache \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    PATH="/opt/stella/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/stella/cache

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      libgl1 \
      libglib2.0-0 \
      libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 stella \
    && useradd \
      --system \
      --uid 1001 \
      --gid stella \
      --no-create-home \
      stella

COPY --from=builder /opt/stella/venv /opt/stella/venv
COPY --from=builder /opt/stella/models /opt/stella/models
COPY apps/ocr-service/pipeline.yaml /opt/stella/pipeline.yaml
COPY apps/ocr-service/healthcheck.py /opt/stella/healthcheck.py
COPY apps/ocr-service/THIRD-PARTY-NOTICES.md /opt/stella/THIRD-PARTY-NOTICES.md

WORKDIR /opt/stella
USER stella

EXPOSE 8080

# Serves Compose/self-host runs; ECS task definitions declare their own health checks.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=4 \
  CMD ["python", "/opt/stella/healthcheck.py"]

CMD ["paddlex", "--serve", "--pipeline", "/opt/stella/pipeline.yaml", "--device", "gpu:0", "--host", "127.0.0.1", "--port", "8080"]
