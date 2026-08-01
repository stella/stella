import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

describe("PDF worker runtime artifact", () => {
  test("bundled parent process finds the bundled PDF worker", async () => {
    const testDir = mkdtempSync(path.join(REPO_ROOT, ".tmp-pdf-worker-"));
    const workerDir = path.join(testDir, "workers");
    const parentDir = path.join(testDir, "parent");
    const entrypoint = path.join(testDir, "entrypoint.ts");

    try {
      mkdirSync(workerDir);
      mkdirSync(parentDir);

      writeFileSync(
        entrypoint,
        `import { Result } from "better-result";
import { isEncryptedPdf } from ${JSON.stringify(path.join(import.meta.dir, "pdf-utils.ts"))};

const result = await isEncryptedPdf(new ArrayBuffer(0));
if (!Result.isError(result)) {
  throw new Error("Expected empty PDF to fail parsing");
}
if (result.error.message.includes("Module not found")) {
  throw new Error(result.error.message);
}
if (!result.error.message.includes("pdf-worker error")) {
  throw new Error(result.error.message);
}
`,
      );

      const workerBuild = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "pdf-worker.ts")],
        naming: "pdf-worker.js",
        outdir: workerDir,
        target: "bun",
      });
      expect(workerBuild.success).toBe(true);

      const parentBuild = await Bun.build({
        entrypoints: [entrypoint],
        outdir: parentDir,
        target: "bun",
      });
      expect(parentBuild.success).toBe(true);

      const result = Bun.spawnSync({
        cmd: ["bun", path.join(parentDir, "entrypoint.js")],
        env: {
          PATH: process.env["PATH"] ?? "",
          STELLA_WORKER_DIR: workerDir,
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(testDir, { force: true, recursive: true });
    }
  });
});
