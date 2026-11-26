import { expect, test } from "bun:test";

import { settledWithin } from "@stll/test-kit";

const IMPORT_TIMEOUT_MS = 10_000;

test(
  "the static MCP tool registry import exits without open handles",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        'await import("./src/tests/setup-env"); await import("./src/mcp/static-tool-definitions");',
      ],
      {
        cwd: import.meta.dirname.replace(/\/scripts$/u, ""),
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      const exitCode = await settledWithin(child.exited, {
        description: "static MCP tool registry import to exit",
        timeoutMs: IMPORT_TIMEOUT_MS,
      });
      expect(exitCode).toBe(0);
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    }
  },
  IMPORT_TIMEOUT_MS + 2000,
);
