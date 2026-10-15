import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
  runtimeOcrPdfFontPath,
  runtimeWorkerDir,
  runtimeYaraRulesDir,
} from "@/api/lib/runtime-worker-path";

const WORKER_DIR_ENV = "STELLA_WORKER_DIR";
const originalWorkerDir = process.env[WORKER_DIR_ENV];

afterEach(() => {
  if (originalWorkerDir === undefined) {
    process.env[WORKER_DIR_ENV] = "";
    return;
  }

  process.env[WORKER_DIR_ENV] = originalWorkerDir;
});

describe("runtime worker paths", () => {
  test.each([
    { name: "STELLA_WORKER_DIR", read: runtimeWorkerDir },
    { name: "STELLA_OCR_PDF_FONT_PATH", read: runtimeOcrPdfFontPath },
    { name: "STELLA_YARA_RULES_DIR", read: runtimeYaraRulesDir },
  ])(
    "external asset paths reject Bun's virtual filesystem ($name)",
    ({ name, read }) => {
      const previous = process.env[name];
      try {
        for (const value of [
          "/$bunfs",
          "/$bunfs/root/workers",
          "/app/../$bunfs/root",
        ]) {
          process.env[name] = value;
          expect(read).toThrow(
            "External runtime assets must use a physical filesystem path",
          );
        }
        process.env[name] = "/app/runtime/workers";
        expect(read()).toBe("/app/runtime/workers");
      } finally {
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = previous;
        }
      }
    },
  );
  test("uses source worker path when no runtime worker directory is configured", () => {
    process.env[WORKER_DIR_ENV] = "";

    expect(
      resolveRuntimeWorkerPath({
        outputFile: RUNTIME_WORKER_FILES.pdf,
        sourceDir: "/repo/apps/api/src/lib/search",
        sourceFile: "worker.ts",
      }),
    ).toBe(path.resolve("/repo/apps/api/src/lib/search", "worker.ts"));
  });

  test("uses bundled worker artifact when runtime worker directory is configured", () => {
    process.env[WORKER_DIR_ENV] = "/runtime/workers";

    expect(
      resolveRuntimeWorkerPath({
        outputFile: RUNTIME_WORKER_FILES.pdf,
        sourceDir: "/repo/apps/api/src/lib/search",
        sourceFile: "worker.ts",
      }),
    ).toBe(path.resolve("/runtime/workers", RUNTIME_WORKER_FILES.pdf));
  });
});
