import { expect, test } from "bun:test";

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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode, type: "exit" as const })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ type: "timeout" as const }),
          IMPORT_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(timeoutId);

    if (outcome.type === "timeout") {
      child.kill();
      await child.exited;
      throw new Error(
        "static MCP tool registry import did not exit within 10s",
      );
    }

    expect(outcome.exitCode).toBe(0);
  },
  IMPORT_TIMEOUT_MS + 2000,
);
