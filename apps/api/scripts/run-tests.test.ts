import { Result } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { deriveApiTestWorkerCount } from "./test-worker-count";

const GIB = 1024 * 1024 * 1024;
const apiRoot = path.resolve(import.meta.dirname, "..");

test("the API runner starts children only through its process owner", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "run-tests.ts"),
    "utf-8",
  );
  expect(source).not.toMatch(/\bBun\.spawn(?:Sync)?\s*\(/u);
  expect(source).toContain("runOwnedTestProcess");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test.skipIf(process.platform === "win32")(
    `runner ${signal} ends a blocked snapshot builder and its descendant`,
    async () => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "api-snapshot-process-"),
      );
      const runnerSource = readFileSync(
        path.join(import.meta.dirname, "run-tests.ts"),
        "utf-8",
      );
      const fixtureScripts = path.join(directory, "scripts");
      const marker = path.join(directory, "ready");
      mkdirSync(fixtureScripts);
      mkdirSync(path.join(directory, "src"));
      symlinkSync(
        path.resolve(apiRoot, "../../node_modules"),
        path.join(directory, "node_modules"),
        "dir",
      );
      for (const imported of new Bun.Transpiler({ loader: "ts" }).scanImports(
        runnerSource,
      )) {
        if (!imported.path.startsWith(".")) {
          continue;
        }
        const target = path.resolve(fixtureScripts, `${imported.path}.ts`);
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(
          Bun.resolveSync(imported.path, import.meta.dirname),
          target,
        );
      }
      writeFileSync(path.join(fixtureScripts, "run-tests.ts"), runnerSource);
      writeFileSync(
        path.join(directory, "src/blocked.db.test.ts"),
        "export {};\n",
      );
      writeFileSync(
        path.join(fixtureScripts, "build-pglite-snapshot.ts"),
        `
        const descendant = Bun.spawn(["sh", "-c", 'trap "" INT TERM; sleep 300 & echo "$!"; wait'], {
          stdout: "pipe", stderr: "ignore",
        });
        const ready = await descendant.stdout.getReader().read();
        const leafPid = new TextDecoder().decode(ready.value).trim();
        await Bun.write(${JSON.stringify(marker)}, String(process.pid) + " " + String(descendant.pid) + " " + leafPid);
        process.on("SIGINT", () => {});
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `,
      );
      const runner = Bun.spawn(
        [process.execPath, path.join(fixtureScripts, "run-tests.ts")],
        {
          cwd: directory,
          detached: true,
          stdout: "ignore",
          stderr: "pipe",
          env: {
            ...process.env,
            CI: "true",
            API_TEST_FILES: "src/blocked.db.test.ts",
            API_TEST_SHARD: "",
            API_TEST_DURATIONS_FILE: "",
            API_TEST_DURATIONS_HASH: "",
            STELLA_PGLITE_SNAPSHOT_CACHE_DIR: "",
          },
        },
      );
      const pids: number[] = [];
      try {
        await waitForExternalState({
          description: "snapshot builder announces its descendant",
          read: () => existsSync(marker),
        });
        pids.push(
          ...readFileSync(marker, "utf-8").trim().split(" ").map(Number),
        );
        expect(pids).toHaveLength(3);
        expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)).toBe(
          true,
        );
        expect(
          pids.every((pid) => Result.try(() => process.kill(pid, 0)).isOk()),
        ).toBe(true);
        runner.kill(signal);
        await runner.exited;
        for (const pid of pids) {
          await waitForExternalState({
            description: `snapshot process ${pid} exits after ${signal}`,
            read: () => {
              const status =
                process.platform === "linux"
                  ? Result.try(() =>
                      readFileSync(`/proc/${pid}/status`, "utf-8"),
                    )
                  : undefined;
              return (
                Result.try(() => process.kill(pid, 0)).isErr() ||
                (status?.isOk() && /^State:\s+Z\b/mu.test(status.value))
              );
            },
          });
        }
        expect(runner.exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      } finally {
        Result.try(() => process.kill(-runner.pid, "SIGKILL"));
        for (const pid of pids) {
          Result.try(() => process.kill(pid, "SIGKILL"));
        }
        await runner.exited;
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

test("memory bounds workers on a many-core low-memory runner", () => {
  expect(
    deriveApiTestWorkerCount({
      availableParallelism: 16,
      totalMemoryBytes: 7 * GIB,
    }),
  ).toBe(2);
});

test("cores bound workers on a few-core high-memory runner", () => {
  expect(
    deriveApiTestWorkerCount({
      availableParallelism: 4,
      totalMemoryBytes: 64 * GIB,
    }),
  ).toBe(3);
});

test("worker count never falls below one", () => {
  expect(
    deriveApiTestWorkerCount({
      availableParallelism: 1,
      totalMemoryBytes: 1024,
    }),
  ).toBe(1);
});
