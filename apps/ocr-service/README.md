# Stella OCR service

This package builds a PaddleX basic-serving endpoint compatible with Stella's
document-processing worker. It serves `POST /ocr` and `GET /health` on port 8080.

This is an optional add-on. Stella and its standard self-host Compose stack do
not require this image, an NVIDIA GPU, or an amd64 host. Those requirements
apply only when an operator opts into this bundled GPU OCR runtime.

The image pins PaddleOCR 3.7.0, PaddleX 3.7.2, and PaddlePaddle GPU 3.2.0 for
CUDA 12.6. PP-OCRv6 medium detection and recognition models are downloaded and
SHA-256 verified while the image is built. Both model directories are wired
into `pipeline.yaml`; the running service does not download model weights.
Third-party source and model licensing is recorded in
`THIRD-PARTY-NOTICES.md` and copied into the image.

The PaddlePaddle CUDA wheel is published for amd64 Linux, so the Dockerfile
rejects other target architectures. The host needs an NVIDIA driver compatible
with CUDA 12.6 and the container must receive an NVIDIA GPU.

Build and run manually:

```bash
docker build --platform linux/amd64 \
  --file apps/ocr-service/Dockerfile \
  --tag stella-ocr-service:local \
  .
```

The image binds PaddleX to container loopback by default and is intended to
share a network namespace with its worker. It does not publish a standalone
OCR endpoint.

For the standard self-host stack, use the optional Compose overlay instead. It
places the worker in the OCR container's network namespace; port 8080 remains
unpublished and `OCR_SERVICE_URL` stays on loopback.

```bash
docker compose \
  --env-file "${STELLA_API_ENV_FILE:-apps/api/.env}" \
  --file docker-compose.selfhost.yml \
  --file docker-compose.ocr.yml \
  up --detach --build
```

This requires Docker Compose with GPU support, NVIDIA Container Toolkit, and an
amd64 NVIDIA host. Operators using Kubernetes can apply the same shape by
placing the API worker and OCR containers in one Pod.

Keep this endpoint on the same private network as the document-processing
worker. Requests contain short-lived document URLs and recognized legal text
must not be written to application logs.

The runtime writes caches and temporary PDF renderings only below `/tmp`. A
read-only deployment must mount a writable, size-bounded tmpfs at `/tmp`; no
persistent volume is required.

## Python dependencies

`pyproject.toml` is the dependency and tool configuration source of truth;
`uv.lock` pins the complete Linux x86_64 environment. The Paddle CUDA index is
explicit, so it cannot supply unrelated packages. Runtime installation uses a
digest-pinned uv image and `uv sync --frozen`.

Ruff and ty are exact-pinned in the development dependency group. CI installs
only that small group before checking the Python health probe; the large Paddle
runtime is installed only by the remote image build.
