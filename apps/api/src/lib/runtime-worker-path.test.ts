import { describe, expect, test } from "bun:test";
import path from "node:path";

import { createTestState } from "@stll/test-state";

import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
  runtimeOcrPdfFontPath,
  runtimeWorkerDir,
  runtimeYaraRulesDir,
} from "@/api/lib/runtime-worker-path";

const WORKER_DIR_ENV = "STELLA_WORKER_DIR";
const state = createTestState({ file: import.meta.path, config: {} });

describe("runtime worker paths", () => {
  test.each([
    { name: "STELLA_WORKER_DIR", read: runtimeWorkerDir },
    { name: "STELLA_OCR_PDF_FONT_PATH", read: runtimeOcrPdfFontPath },
    { name: "STELLA_YARA_RULES_DIR", read: runtimeYaraRulesDir },
  ])(
    "external asset paths reject Bun's virtual filesystem ($name)",
    ({ name, read }) => {
      for (const value of [
        "/$bunfs",
        "/$bunfs/root/workers",
        "/app/../$bunfs/root",
      ]) {
        state.setEnv(name, value);
        expect(read).toThrow(
          "External runtime assets must use a physical filesystem path",
        );
      }
      state.setEnv(name, "/app/runtime/workers");
      expect(read()).toBe("/app/runtime/workers");
    },
  );
  test("uses source worker path when no runtime worker directory is configured", () => {
    state.setEnv(WORKER_DIR_ENV, "");

    expect(
      resolveRuntimeWorkerPath({
        outputFile: RUNTIME_WORKER_FILES.pdf,
        sourceDir: "/repo/apps/api/src/lib/search",
        sourceFile: "worker.ts",
      }),
    ).toBe(path.resolve("/repo/apps/api/src/lib/search", "worker.ts"));
  });

  test("uses bundled worker artifact when runtime worker directory is configured", () => {
    state.setEnv(WORKER_DIR_ENV, "/runtime/workers");

    expect(
      resolveRuntimeWorkerPath({
        outputFile: RUNTIME_WORKER_FILES.pdf,
        sourceDir: "/repo/apps/api/src/lib/search",
        sourceFile: "worker.ts",
      }),
    ).toBe(path.resolve("/runtime/workers", RUNTIME_WORKER_FILES.pdf));
  });
});
