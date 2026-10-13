import { Result } from "better-result";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnGatedTestProcess } from "./test-process-spawn";

test.each(["eval", "test"] as const)(
  "%s entry point stays gated throughout slow ownership registration",
  async (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-gate-test-"));
    const marker = path.join(directory, "executed");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); console.log(process.env.STELLA_TEST_PROCESS_STARTUP_GATE ?? 'released')`;
    const file = path.join(directory, "gated.test.ts");
    writeFileSync(
      file,
      `${source}; const {test}=require('bun:test'); test('gated',()=>{});`,
    );
    try {
      const { child } = spawnGatedTestProcess(
        {
          command: [
            process.execPath,
            ...(mode === "eval" ? ["-e", source] : ["test", file]),
          ],
          options: { stdout: "pipe", stderr: "inherit" },
          onWarning: (message) => {
            throw new TypeError(message);
          },
        },
        (pid) => {
          // Longer than this trivial entry point needs, reproducing census startup.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
          expect(existsSync(marker)).toBe(false);
          expect(Result.try(() => process.kill(pid, 0)).isOk()).toBe(true);
          return Result.ok({
            readPeakMemory: () => Result.ok(0),
            signal: () => Result.ok(undefined),
          });
        },
      );
      expect(await new Response(child.stdout).text()).toMatch(
        /(?:^|\n)released\n$/u,
      );
      expect(await child.exited).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("failed leader registration never releases the entry point", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-gate-failure-"));
  const marker = path.join(directory, "executed");
  try {
    expect(() =>
      spawnGatedTestProcess(
        {
          command: [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unowned')`,
          ],
          options: { stdout: "ignore", stderr: "inherit" },
          onWarning: (message) => {
            throw new TypeError(message);
          },
        },
        () => Result.err(new TypeError("Registration failed")),
      ),
    ).toThrow("Registration failed");
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
