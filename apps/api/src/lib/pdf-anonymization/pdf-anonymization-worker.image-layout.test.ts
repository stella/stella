import { PDF } from "@libpdf/core";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inspectPdf } from "@stll/anonymize-pdf";

import {
  decodePdfAnonymizationWorkerResponse,
  encodePdfAnonymizationWorkerRequest,
} from "@/api/lib/pdf-anonymization/worker-protocol";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const WORKER_SOURCE = path.resolve(
  import.meta.dir,
  "pdf-anonymization-worker.ts",
);

test("the PDF rewrite bundle runs with only shipped native assets and no install cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pdf-rewrite-image-layout-"));
  try {
    const workersDir = path.join(root, "workers");
    await mkdir(workersDir);
    // Native .node bindings produce multiple build artifacts, as in the image.
    const build = Bun.spawn(
      [
        "bun",
        "build",
        "--target",
        "bun",
        "--outdir",
        workersDir,
        WORKER_SOURCE,
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [buildStdout, buildStderr, buildExit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(buildExit, `${buildStdout}\n${buildStderr}`).toBe(0);
    const artifacts = await readdir(workersDir);
    expect(artifacts).toContain("pdf-anonymization-worker.js");
    expect(artifacts.some((file) => file.endsWith(".node"))).toBe(true);
    await cp(
      path.join(REPO_ROOT, "node_modules/@hyzyla/pdfium/dist/pdfium.wasm"),
      path.join(workersDir, "pdfium.wasm"),
    );
    const emptyBunInstall = path.join(root, "empty-bun-install");
    await mkdir(emptyBunInstall);
    expect((await readdir(root)).sort()).toEqual([
      "empty-bun-install",
      "workers",
    ]);
    expect(await readdir(emptyBunInstall)).toEqual([]);

    const source = PDF.create();
    source.addPage({ width: 72, height: 72 });
    source.setAuthor("Private fixture author");
    const sourceBytes = await source.save();
    expect(
      inspectPdf(sourceBytes).risks.documentInfoEntryCount,
    ).toBeGreaterThan(0);
    const request = encodePdfAnonymizationWorkerRequest({
      document: sourceBytes,
      pages: [{ ocr: { width: 72, height: 72, lines: [] }, detections: [] }],
    });
    const worker = Bun.spawn(
      ["bun", "run", path.join(workersDir, "pdf-anonymization-worker.js")],
      {
        cwd: root,
        stdin: new Blob([request.slice().buffer]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
        // No inherited module paths or developer install cache may resolve assets.
        env: { PATH: process.env["PATH"] ?? "", BUN_INSTALL: emptyBunInstall },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(worker.stdout).bytes(),
      new Response(worker.stderr).text(),
      worker.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const output = decodePdfAnonymizationWorkerResponse(stdout);
    expect(output.certificate).toMatchObject({
      sourceSha256: new Bun.CryptoHasher("sha256")
        .update(sourceBytes)
        .digest("hex"),
      outputSha256: new Bun.CryptoHasher("sha256")
        .update(output.document)
        .digest("hex"),
      pageCount: 1,
      detectionCount: 0,
      mappedRegionCount: 0,
      structurePixelRewriteVerified: true,
      piiCleanGuaranteed: false,
    });
    const inspection = inspectPdf(output.document);
    expect(inspection.pageCount).toBe(1);
    expect(inspection.encrypted).toBe(false);
    for (const [risk, count] of Object.entries(inspection.risks)) {
      expect(count, risk).toBe(risk === "imageObjectCount" ? 1 : 0);
    }
    const rewritten = await PDF.load(output.document);
    expect(
      rewritten.getPages().map(({ width, height }) => ({ width, height })),
    ).toEqual([{ width: 72, height: 72 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
