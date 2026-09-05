/**
 * Reproduces the runner image's filesystem layout for the OCR worker and
 * executes the bundle inside it with Bun's install cache disabled.
 *
 * The class this pins: a bundled worker that resolves a native asset
 * through a hidden fallback on the developer machine — the repository's
 * node_modules or Bun's global cache — and then fails in the runner
 * image, where only the explicitly shipped assets exist. A native platform
 * binding failed exactly this way. Layout comes from
 * `RUNTIME_WORKER_NATIVE_LOOKUPS` and `RUNTIME_WORKER_SIDECAR_FILES`.
 * The Dockerfile's native-asset materializer imports the same lookup builder.
 *
 * Requires the pinned ONNX models (`bun run ocr:fetch-models`); skips on
 * a checkout without them. The image build's smoke stage runs the same
 * probe against the real image as the enforced backstop.
 */

import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OCR_LOCAL_MODEL_FILES } from "@/api/lib/document-processing-contract";
import { RUNTIME_WORKER_NATIVE_LOOKUPS } from "@/api/lib/runtime-worker-path";

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const REPO_ROOT = path.resolve(API_ROOT, "../..");
const MODEL_DIR = path.join(API_ROOT, "ocr-models");
const WORKER_SOURCE = path.resolve(import.meta.dir, "ocr-local-worker.ts");

const modelsPresent = await Promise.all(
  Object.values(OCR_LOCAL_MODEL_FILES).map(
    async (file) => await Bun.file(path.join(MODEL_DIR, file)).exists(),
  ),
).then((results) => results.every(Boolean));

const BLANK_PAGE_PDF = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
  "trailer << /Size 4 /Root 1 0 R >>",
].join("\n");

describe.skipIf(!modelsPresent)("ocr-local-worker image layout", () => {
  test("the bundle runs with only the shipped assets and no install cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ocr-image-layout-"));
    try {
      const workersDir = path.join(root, "workers");
      await mkdir(workersDir, { recursive: true });

      const build = Bun.spawn(
        [
          "bun",
          "build",
          "--target",
          "bun",
          "--outfile",
          path.join(workersDir, "ocr-local-worker.js"),
          WORKER_SOURCE,
        ],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);

      // Worker-relative sidecars, as the Dockerfile copies them.
      await cp(
        path.join(REPO_ROOT, "node_modules/@hyzyla/pdfium/dist/pdfium.wasm"),
        path.join(workersDir, "pdfium.wasm"),
      );
      await cp(
        path.join(import.meta.dir, "latin-v5-dict.txt"),
        path.join(workersDir, "latin-v5-dict.txt"),
      );
      // Native lookups from the shared manifest.
      for (const dir of RUNTIME_WORKER_NATIVE_LOOKUPS.siblingDirs) {
        await cp(
          path.join(REPO_ROOT, "node_modules", dir.source),
          path.join(root, dir.target),
          { recursive: true },
        );
      }

      const emptyBunInstall = path.join(root, "empty-bun-install");
      await mkdir(emptyBunInstall, { recursive: true });
      const subprocess = Bun.spawn(
        ["bun", "run", path.join(workersDir, "ocr-local-worker.js"), MODEL_DIR],
        {
          cwd: root,
          stdin: new Blob([BLANK_PAGE_PDF]),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 120_000,
          env: {
            PATH: process.env["PATH"] ?? "",
            // No global cache: every native asset must come from the
            // layout above, exactly as in the runner image.
            BUN_INSTALL: emptyBunInstall,
          },
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(
          `worker failed in image layout (exit ${exitCode}): ${stderr.slice(0, 500)}`,
        );
      }
      const parsed: unknown = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        pages: [{ width: 612, height: 792, lines: [] }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
