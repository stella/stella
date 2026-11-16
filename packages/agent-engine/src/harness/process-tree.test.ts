import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDetached } from "@stll/errors";
import { waitForExternalState } from "@stll/property-testing/external-state";

import { PROTOCOL_LOG_OFF } from "../protocol-log";
import { startHarnessProcess } from "./harness-process";

const FAKE_SERVER = path.join(
  import.meta.dir,
  "../../scripts/fake-codex-app-server.ts",
);
const FAKE_HOLDER = path.join(
  import.meta.dir,
  "../../scripts/fake-harness-holder.ts",
);

const cleanups: (() => void)[] = [];
const backgroundErrors: unknown[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  expect(backgroundErrors.splice(0)).toEqual([]);
});

/** Whether `pid` still runs: listed, and not a zombie waiting to be reaped. */
const runs = (pid: number) => {
  const listed = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const state = listed.stdout.toString().trim();
  return state !== "" && !state.startsWith("Z");
};

/**
 * Waits up to `ms` for none of `pids` to run; the ones still running. They
 * are other processes' children, so their end raises no event here.
 */
const stillRunning = async (pids: readonly number[], ms: number) =>
  await waitForExternalState({
    description: "every process of the harness's group ended",
    read: () => (pids.some(runs) ? null : []),
    intervalMs: 50,
    timeoutMs: ms,
    onTimeout: () => pids.filter(runs),
  });

/** A fresh folder with the fake's log, and the pids it reports spawning. */
const fakeLog = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-process-tree-"));
  const log = path.join(root, "fake.log");
  const spawned = () =>
    (existsSync(log) ? readFileSync(log, "utf-8") : "")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line))
      .flatMap((entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "spawned" in entry &&
        typeof entry.spawned === "number"
          ? [entry.spawned]
          : [],
      );
  cleanups.push(() => {
    // Whatever a failed test left behind; each is a process this test made.
    for (const pid of spawned()) {
      Result.try(() => process.kill(pid, "SIGKILL"));
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, log, spawned };
};

/** The fake harness, leaving processes the ways agents' commands do. */
const startLeaving = (root: string, log: string) => {
  const ready = Promise.withResolvers<undefined>();
  const started = startHarnessProcess<number, Error>({
    command: [process.execPath, FAKE_SERVER, "leaves_processes"],
    cwd: root,
    env: { FAKE_HARNESS_LOG: log, PATH: process.env["PATH"] ?? "" },
    detached: createDetached((error) => {
      backgroundErrors.push(error);
    }),
    deadlines: { requestMs: 30_000, terminateMs: 300 },
    name: "fake-codex",
    protocol: { channel: "codex", log: PROTOCOL_LOG_OFF },
    unanswered: (_reason, message) => new Error(message),
    message: (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "method" in value &&
        value.method === "fake/ready"
      ) {
        ready.resolve(undefined);
      }
    },
    violation: (message) => {
      backgroundErrors.push(message);
    },
    exit: () => undefined,
  });
  const harness = Result.isOk(started)
    ? started.value
    : panic("the fake harness did not start");
  return { harness, ready: ready.promise };
};

describe.skipIf(process.platform === "win32")(
  "a harness process ends with everything it started",
  () => {
    test("a stop ends its children, one in its own process group, an orphaned one, and one that ignores SIGTERM", async () => {
      const { root, log, spawned } = fakeLog();
      const { harness, ready } = startLeaving(root, log);
      await ready;
      const pids = spawned();
      expect(pids).toHaveLength(4);
      expect(pids.filter(runs)).toEqual(pids);

      expect(await harness.kill()).toEqual({
        exitCode: null,
        signal: "SIGTERM",
      });
      // Gone once the stop settles, the one ignoring SIGTERM by SIGKILL.
      expect(pids.filter(runs)).toEqual([]);
    });

    test("a harness that exits on its own takes what it started with it", async () => {
      const { root, log, spawned } = fakeLog();
      const { harness, ready } = startLeaving(root, log);
      await ready;
      const pids = spawned();
      expect(pids.filter(runs)).toEqual(pids);

      // A finished turn closes stdin and the harness exits by itself.
      harness.closeInput();
      expect(await harness.exited).toEqual({ exitCode: 0, signal: null });
      expect(pids.filter(runs)).toEqual([]);
    });

    test("a holder that dies without ending its harness still has the harness's group ended", async () => {
      const { root, log, spawned } = fakeLog();
      const holder = Bun.spawn(
        [process.execPath, FAKE_HOLDER, FAKE_SERVER, "leaves_processes", log],
        { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" },
      );
      cleanups.push(() => {
        holder.kill("SIGKILL");
      });
      const said = holder.stdout.getReader();
      const first = await said.read();
      expect(new TextDecoder().decode(first.value)).toBe("ready\n");
      said.releaseLock();
      const pids = spawned();
      expect(pids.filter(runs)).toEqual(pids);
      const [cli] = readFileSync(log, "utf-8")
        .split("\n")
        .slice(0, 1)
        .map((line): unknown => JSON.parse(line));
      const cliPid =
        typeof cli === "object" &&
        cli !== null &&
        "startup" in cli &&
        typeof cli.startup === "object" &&
        cli.startup !== null &&
        "pid" in cli.startup &&
        typeof cli.startup.pid === "number"
          ? cli.startup.pid
          : null;
      expect(cliPid).not.toBeNull();

      // As a crash ends the sidecar: no stop runs, nothing is signalled.
      holder.kill("SIGKILL");
      await holder.exited;
      // The CLI's group, whatever ignores SIGTERM once the grace passes. A
      // process in a group of its own is out of the watcher's reach.
      const [plain, , orphan, ignoringTerm] = pids;
      expect(
        await stillRunning(
          [cliPid ?? 0, plain ?? 0, orphan ?? 0, ignoringTerm ?? 0],
          5000,
        ),
      ).toEqual([]);
    });

    test("a missing CLI is refused when it is started", () => {
      const { root } = fakeLog();
      const started = startHarnessProcess<number, Error>({
        command: [path.join(root, "no-such-cli")],
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "" },
        detached: createDetached((error) => {
          backgroundErrors.push(error);
        }),
        deadlines: { requestMs: 1000, terminateMs: 300 },
        name: "missing",
        protocol: { channel: "codex", log: PROTOCOL_LOG_OFF },
        unanswered: (_reason, message) => new Error(message),
        message: () => undefined,
        violation: () => undefined,
        exit: () => undefined,
      });
      expect(Result.isError(started) && started.error.reason).toBe("not_found");
    });
  },
);
