import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const posixTest = process.platform === "win32" ? test.skip : test;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const) {
  posixTest(
    `runner ${signal} forwards shutdown and reaps its detached child`,
    async () => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "stella-shutdown-test-"),
      );
      const marker = path.join(directory, "signal");
      const parent = Bun.spawn(
        [
          process.execPath,
          `${import.meta.dir}/test-fixtures/signal-cleanup-parent.ts`,
          marker,
        ],
        {
          stdout: "pipe",
          stderr: "inherit",
          env: { ...process.env, SHUTDOWN_FIXTURE_MODE: signal },
        },
      );
      let childPid: number | undefined;
      let grandchildPid: number | undefined;
      try {
        const reader = parent.stdout.getReader();
        const ready = await reader.read();
        [childPid, grandchildPid] = new TextDecoder()
          .decode(ready.value)
          .trim()
          .split(/\s+/u)
          .map(Number);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(childPid).toBeGreaterThan(1);
        expect(Number.isSafeInteger(grandchildPid)).toBe(true);
        expect(grandchildPid).toBeGreaterThan(1);
        if (signal !== "exit") {
          parent.kill(signal);
        }
        await parent.exited;
        if (signal === "exit") {
          expect(parent.exitCode).toBe(23);
        } else {
          expect(parent.exitCode).toBe(SIGNAL_EXIT_CODES[signal]);
          expect(readFileSync(marker, "utf-8")).toBe(signal);
          expect(readFileSync(`${marker}.grandchild`, "utf-8")).toBe(signal);
        }
        // The parent's exit and the kernel's child reap notification can differ by a tick.
        await Bun.sleep(50);
        for (const pid of [childPid, grandchildPid]) {
          if (pid === undefined) {
            throw new TypeError("Fixture readiness must contain both PIDs");
          }
          const alive = Result.try(() => process.kill(pid, 0));
          const status =
            process.platform === "linux"
              ? Result.try(() => readFileSync(`/proc/${pid}/status`, "utf-8"))
              : undefined;
          const zombie = status?.isOk() && /^State:\s+Z\b/mu.test(status.value);
          expect(alive.isErr() || zombie).toBe(true);
        }
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill("SIGKILL");
          await parent.exited;
        }
        if (
          childPid !== undefined &&
          Number.isSafeInteger(childPid) &&
          childPid > 1
        ) {
          const ownedGroupPid = childPid;
          Result.try(() => process.kill(-ownedGroupPid, "SIGKILL"));
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
