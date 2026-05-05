import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveRuntimeWorkerPath } from "@/api/lib/runtime-worker-path";

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
  test("uses source worker path when no runtime worker directory is configured", () => {
    process.env[WORKER_DIR_ENV] = "";

    expect(
      resolveRuntimeWorkerPath({
        outputFile: "worker.js",
        sourceDir: "/repo/apps/api/src/lib/search",
        sourceFile: "worker.ts",
      }),
    ).toBe(resolve("/repo/apps/api/src/lib/search", "worker.ts"));
  });

  test("uses bundled worker artifact when runtime worker directory is configured", () => {
    process.env[WORKER_DIR_ENV] = "/runtime/workers";

    expect(
      resolveRuntimeWorkerPath({
        outputFile: "worker.js",
        sourceDir: "/repo/apps/api/src/lib/search",
        sourceFile: "worker.ts",
      }),
    ).toBe(resolve("/runtime/workers", "worker.js"));
  });
});
