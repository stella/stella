import { describe, expect, test } from "bun:test";

const packageDirectory = new URL("./", import.meta.url);
const dockerfile = await Bun.file(
  new URL("Dockerfile", packageDirectory),
).text();
const pipeline = await Bun.file(
  new URL("pipeline.yaml", packageDirectory),
).text();
const healthcheck = await Bun.file(
  new URL("healthcheck.py", packageDirectory),
).text();
const pyproject = await Bun.file(
  new URL("pyproject.toml", packageDirectory),
).text();
const uvLock = await Bun.file(new URL("uv.lock", packageDirectory)).text();
const dockerignore = await Bun.file(
  new URL("Dockerfile.dockerignore", packageDirectory),
).text();

describe("OCR service image contract", () => {
  test("pins the runtime and Paddle stack", () => {
    const pythonBaseImages = dockerfile.match(/^FROM\s+python:(\S+)/gmu) ?? [];

    expect(pythonBaseImages).toHaveLength(2);
    for (const image of pythonBaseImages) {
      expect(image).toContain("python:3.11-slim-bookworm@sha256:");
    }
    expect(dockerfile).toContain("ghcr.io/astral-sh/uv:0.11.32@sha256:");
    expect(dockerfile).toContain("uv sync --frozen --no-dev");
    expect(pyproject).toContain('"paddleocr==3.7.0"');
    expect(pyproject).toContain('"paddlex[ocr,serving]==3.7.2"');
    expect(pyproject).toContain('"paddlepaddle-gpu==3.2.0"');
    expect(uvLock).toContain('name = "paddlepaddle-gpu"');
    expect(uvLock).toContain('name = "paddlex"');
  });

  test("uses the Astral toolchain with a quarantined lock", () => {
    expect(pyproject).toContain('"ruff==0.16.0"');
    expect(pyproject).toContain('"ty==0.0.63"');
    expect(pyproject).toContain('exclude-newer = "2026-07-26T00:00:00Z"');
    expect(uvLock).toContain('name = "ruff"');
    expect(uvLock).toContain('name = "ty"');
  });

  test("verifies both model archives before extraction", () => {
    expect(dockerfile).toContain(
      "TEXT_DETECTION_MODEL_SHA256=144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7",
    );
    expect(dockerfile).toContain(
      "TEXT_RECOGNITION_MODEL_SHA256=4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6",
    );
    expect(dockerfile.match(/sha256sum --check --strict/gu)).toHaveLength(2);
    expect(dockerfile).toContain("curl --fail --location --proto '=https'");
  });

  test("runs unprivileged with a local health probe", () => {
    expect(dockerfile).toContain("USER stella");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain('/opt/stella/healthcheck.py"]');
    expect(dockerfile).toContain('"--host", "127.0.0.1"');
    expect(dockerfile).not.toContain('"--host", "0.0.0.0"');
    expect(healthcheck).toContain("http://127.0.0.1:8080/health");
    expect(dockerfile).toContain("HF_HUB_OFFLINE=1");
    expect(dockerfile).toContain("HOME=/tmp/stella/home");
    expect(dockerfile).toContain(
      "PADDLE_PDX_CACHE_HOME=/tmp/stella/paddlex-cache",
    );
  });

  test("sends only the OCR service slice to the image builder", () => {
    expect(dockerignore.split("\n").filter((line) => line.length > 0)).toEqual([
      "**",
      "!apps/",
      "!apps/ocr-service/",
      "!apps/ocr-service/Dockerfile",
      "!apps/ocr-service/Dockerfile.dockerignore",
      "!apps/ocr-service/healthcheck.py",
      "!apps/ocr-service/pipeline.yaml",
      "!apps/ocr-service/pyproject.toml",
      "!apps/ocr-service/THIRD-PARTY-NOTICES.md",
      "!apps/ocr-service/uv.lock",
    ]);
    expect(dockerfile).not.toContain("# syntax=");
  });
});

describe("OCR pipeline contract", () => {
  test("uses only the baked PP-OCRv6 medium models", () => {
    expect(pipeline).toContain("pipeline_name: OCR");
    expect(pipeline).toContain("model_name: PP-OCRv6_medium_det");
    expect(pipeline).toContain("model_dir: /opt/stella/models/text-detection");
    expect(pipeline).toContain("model_name: PP-OCRv6_medium_rec");
    expect(pipeline).toContain(
      "model_dir: /opt/stella/models/text-recognition",
    );
    expect(pipeline).not.toContain("model_dir: null");
  });

  test("keeps Paddle serving bounded and non-visual", () => {
    expect(pipeline).toContain("use_doc_preprocessor: false");
    expect(pipeline).toContain("use_textline_orientation: false");
    expect(pipeline).toContain("visualize: false");
    expect(pipeline).toContain("max_num_input_imgs: 501");
  });
});
