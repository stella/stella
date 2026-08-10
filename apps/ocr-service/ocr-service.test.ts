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

describe("OCR service image contract", () => {
  test("verifies both model archives before extraction", () => {
    expect(
      dockerfile.match(
        /TEXT_(?:DETECTION|RECOGNITION)_MODEL_SHA256=[a-f0-9]{64}/gu,
      ),
    ).toHaveLength(2);
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
});

describe("OCR pipeline contract", () => {
  test("uses baked model files instead of runtime downloads", () => {
    expect(pipeline).not.toContain("model_dir: null");
    expect(pipeline.match(/model_dir: \/opt\/stella\/models\//gu)).toHaveLength(
      2,
    );
  });

  test("keeps Paddle serving bounded and non-visual", () => {
    expect(pipeline).toContain("use_doc_preprocessor: false");
    expect(pipeline).toContain("use_textline_orientation: false");
    expect(pipeline).toContain("visualize: false");
    expect(pipeline).toContain("max_num_input_imgs: 501");
  });
});
