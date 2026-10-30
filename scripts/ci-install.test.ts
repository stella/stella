import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createInstallWatchdog,
  installStoreProgress,
  installWarningBudgetMs,
  retryStalledInstall,
  runLoggedInstall,
} from "./ci-install";

const roots: string[] = [];
test("Windows installs retain cold-install headroom regardless of cache contents", () => {
  expect(installWarningBudgetMs("win32")).toBe(240_000);
  expect(installWarningBudgetMs("linux")).toBe(120_000);
  expect(installWarningBudgetMs("darwin")).toBe(120_000);
});
test("caller warning budgets retain platform validation", () => {
  expect(installWarningBudgetMs("linux", "90000")).toBe(90_000);
  expect(installWarningBudgetMs("win32", "90000")).toBe(90_000);
  expect(installWarningBudgetMs("linux", "")).toBe(120_000);
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "120001", "1e3"]) {
    expect(() => installWarningBudgetMs("linux", value)).toThrow(
      "within the platform limit",
    );
  }
  expect(() => installWarningBudgetMs("win32", "240001")).toThrow(
    "within the platform limit",
  );
});
test("the workflow leaves install budgets to the platform owner", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  );
  expect(workflow).not.toContain("CI_INSTALL_CACHE_RESTORED");
  expect(workflow).not.toContain("Select install budget from restored cache");
});
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("failed installers do not retry and stalled installers retry exactly once", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-install-"));
  roots.push(root);
  const logFile = path.join(root, "logs/install.log");
  expect(
    await runLoggedInstall({
      command: [
        process.execPath,
        "-e",
        'console.log("stdout evidence"); console.error("stderr evidence"); process.exit(7)',
      ],
      logFile,
    }),
  ).toBe(7);
  const failed = readFileSync(logFile, "utf-8");
  expect(failed).toContain("stdout evidence");
  expect(failed).toContain("stderr evidence");
  expect(failed.match(/Install started/gu)).toHaveLength(1);
  expect(
    await runLoggedInstall({
      command: [
        process.execPath,
        "-e",
        'console.log("partial output before hang"); setInterval(() => {}, 1000)',
      ],
      logFile,
      budgetMs: installWarningBudgetMs("linux", "500"),
      stallMs: 500,
      progressRoots: [],
    }),
  ).not.toBe(0);
  const hung = readFileSync(logFile, "utf-8");
  expect(hung).toContain("partial output before hang");
  expect(hung).toContain("Install finished;");
  expect(hung).toContain("kind=infra class=install-stall");
  expect(hung.match(/Install started/gu)).toHaveLength(2);
  expect(hung).toContain("class=install-stall");
});

test("a stalled fake child is killed, retried once, and can recover", async () => {
  const attempts: number[] = [];
  const result = await retryStalledInstall(async (attempt) => {
    attempts.push(attempt);
    return attempt === 1
      ? { exitCode: 137, stalled: true }
      : { exitCode: 0, stalled: false };
  });
  expect(attempts).toEqual([1, 2]);
  expect(result).toEqual({ exitCode: 0, stalled: false, retried: true });
});

test("two stalled fake children produce a typed terminal stall", async () => {
  const attempts: number[] = [];
  const result = await retryStalledInstall(async (attempt) => {
    attempts.push(attempt);
    return { exitCode: 137, stalled: true };
  });
  expect(attempts).toEqual([1, 2]);
  expect(result).toEqual({ exitCode: 137, stalled: true, retried: true });
});

test("initial recording failures clean up before install monitoring starts", async () => {
  const root = mkdtempSync(
    path.join(tmpdir(), "ci-install-initial-recording-"),
  );
  roots.push(root);
  const recordingError = new Error("installer log cannot be initialized");
  let attempts = 0;
  let kills = 0;
  let activeTimers = 0;
  let exitCode: number | null = null;
  const exit = Promise.withResolvers<number>();

  const attempt = runLoggedInstall({
    command: ["fake-install"],
    logFile: path.join(root, "install.log"),
    record: () => {
      throw recordingError;
    },
    scheduleInterval: () => {
      activeTimers += 1;
      return () => {
        activeTimers -= 1;
      };
    },
    spawn: () => {
      attempts += 1;
      return {
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exited: exit.promise,
        get exitCode() {
          return exitCode;
        },
        signalCode: null,
        kill: () => {
          kills += 1;
          exitCode = 137;
          exit.resolve(exitCode);
        },
      };
    },
  });

  expect(await rejectionOf(attempt)).toBe(recordingError);
  expect(attempts).toBe(1);
  expect(kills).toBe(1);
  expect(activeTimers).toBe(0);
});

test("recording failures clean up the active install attempt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-install-recording-"));
  roots.push(root);
  const recordingError = new Error("installer log is full");
  let attempts = 0;
  let kills = 0;
  let probes = 0;
  let probeSettled = false;
  let exitCode: number | null = null;
  const exit = Promise.withResolvers<number>();
  const probe = Promise.withResolvers<undefined>();
  let fireTimer: () => void = () => undefined;
  let timerActive = false;
  let now = 0;
  const timerCancelled = Promise.withResolvers<undefined>();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>();
  let writes = 0;
  const recordingFailed = Promise.withResolvers<undefined>();

  const attempt = runLoggedInstall({
    command: ["fake-install"],
    logFile: path.join(root, "install.log"),
    budgetMs: 1000,
    stallMs: 10,
    progressRoots: [],
    now: () => now,
    record: (descriptor, chunk) => {
      writes += 1;
      if (writes === 2) {
        recordingFailed.resolve(undefined);
        throw recordingError;
      }
      writeFileSync(descriptor, chunk);
    },
    sampleStore: async (_roots, active) => {
      probes += 1;
      await probe.promise;
      expect(active?.()).toBe(false);
      probeSettled = true;
      return { signature: "", newest: 0 };
    },
    scheduleInterval: (callback) => {
      timerActive = true;
      fireTimer = () => {
        if (timerActive) {
          return callback();
        }
      };
      return () => {
        timerActive = false;
        timerCancelled.resolve(undefined);
      };
    },
    spawn: () => {
      attempts += 1;
      return {
        stdout,
        stderr,
        exited: exit.promise,
        get exitCode() {
          return exitCode;
        },
        signalCode: null,
        kill: () => {
          kills += 1;
          exitCode = 137;
          exit.resolve(exitCode);
        },
      };
    },
  });

  now = 5;
  fireTimer();
  stdoutController?.enqueue(Buffer.from("first installer chunk"));
  await recordingFailed.promise;
  await timerCancelled.promise;
  probe.resolve(undefined);
  expect(await rejectionOf(attempt)).toBe(recordingError);

  expect(attempts).toBe(1);
  expect(kills).toBe(1);
  expect(probeSettled).toBe(true);
  const probesAfterRejection = probes;
  expect(timerActive).toBe(false);
  fireTimer();
  expect(probes).toBe(probesAfterRejection);
});

test.each([0, 7])(
  "verbose installer output stays complete in the artifact with bounded console output (exit %i)",
  async (exitCode) => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-install-verbose-"));
    roots.push(root);
    const logFile = path.join(root, "install.log");
    const consoleOutput: string[] = [];
    expect(
      await runLoggedInstall({
        command: [
          process.execPath,
          "-e",
          `console.log("begin evidence"); console.log("verbose extraction\\n".repeat(10000)); console.error("last diagnostic"); process.exit(${exitCode})`,
        ],
        logFile,
        report: (message) => {
          consoleOutput.push(message);
        },
      }),
    ).toBe(exitCode);
    const artifact = readFileSync(logFile, "utf-8");
    expect(artifact).not.toContain("class=install-signal");
    expect(artifact).toContain("signal none;");
    expect(artifact).toContain("begin evidence");
    expect(artifact).toContain("last diagnostic");
    expect(artifact.match(/verbose extraction/gu)).toHaveLength(10_000);
    expect(artifact.match(/Install started/gu)).toHaveLength(1);
    const reported = consoleOutput.join("");
    expect(reported).not.toContain("class=install-signal");
    expect(reported).toContain("Install started;");
    expect(reported).toContain(`Install finished; exit ${exitCode};`);
    expect(reported.length).toBeLessThan(5000);
    expect(reported).not.toContain("begin evidence");
    if (exitCode !== 0) {
      expect(reported).toContain("Installer log tail:");
    } else {
      expect(reported).not.toContain("verbose extraction");
    }
  },
);

test("slow progressing installs warn once and pass beyond the wall budget (fake clock)", () => {
  let now = 0;
  const events: string[] = [];
  const monitor = createInstallWatchdog({
    budgetMs: 90,
    stallMs: 120,
    now: () => now,
    warn: () => {
      events.push("warning");
    },
    kill: () => {
      events.push("install-stall");
    },
  });
  for (now = 50; now <= 500; now += 50) {
    monitor.progress();
    monitor.tick();
  }
  monitor.finish();
  expect(events).toEqual(["warning"]);
  expect(monitor.wasStalled()).toBe(false);
});

test("silent hangs warn then emit exactly one stall kill (fake clock)", () => {
  let now = 0;
  const events: string[] = [];
  const monitor = createInstallWatchdog({
    budgetMs: 90,
    stallMs: 120,
    now: () => now,
    warn: () => {
      events.push("warning");
    },
    kill: () => {
      events.push("install-stall");
    },
  });
  now = 90;
  monitor.tick();
  now = 119;
  monitor.tick();
  expect(events).toEqual(["warning"]);
  now = 120;
  monitor.tick();
  now = 500;
  monitor.tick();
  expect(events).toEqual(["warning", "install-stall"]);
  expect(monitor.wasStalled()).toBe(true);
});

test("file extraction and growing downloads count as progress without installer output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-install-progress-"));
  roots.push(root);
  const initial = await installStoreProgress([root]);
  mkdirSync(path.join(root, "package"));
  const file = path.join(root, "package/download");
  writeFileSync(file, "partial");
  const extracted = await installStoreProgress([root]);
  expect(extracted.signature).not.toBe(initial.signature);
  writeFileSync(file, "complete download");
  expect((await installStoreProgress([root])).signature).not.toBe(
    extracted.signature,
  );
});

test.each(["hit", "cold"] as const)(
  "a progressing child succeeds after its %s warning budget",
  async (restoreOutcome) => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-install-slow-"));
    roots.push(root);
    const messages: string[] = [];
    const result = await runLoggedInstall({
      command: [
        process.execPath,
        "-e",
        'const timer = setInterval(() => console.log("extracting"), 10); setTimeout(() => { clearInterval(timer); process.exit(0); }, 100)',
      ],
      logFile: path.join(root, "install.log"),
      budgetMs: 20,
      stallMs: 1000,
      restoreOutcome,
      storeKey: restoreOutcome === "hit" ? "test-key" : undefined,
      progressRoots: [],
      report: (message) => {
        messages.push(message);
      },
    });
    expect(result).toBe(0);
    expect(messages.join("")).toContain("::warning title=install-budget::");
    expect(messages.join("")).toContain(
      `restore=${restoreOutcome} key=${restoreOutcome === "hit" ? "test-key" : "uncached:filtered-install"}`,
    );
    expect(messages.join("")).not.toContain("class=install-stall");
  },
);

test("silent extraction continues beyond the stall interval while files change", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-install-silent-"));
  roots.push(root);
  const store = path.join(root, "store");
  mkdirSync(store);
  const messages: string[] = [];
  expect(
    await runLoggedInstall({
      command: [
        process.execPath,
        "-e",
        'const fs = require("node:fs"); let bytes = ""; const timer = setInterval(() => { bytes += "x"; fs.writeFileSync(process.argv.at(-1), bytes); }, 30); setTimeout(() => { clearInterval(timer); process.exit(0); }, 1000)',
        path.join(store, "download"),
      ],
      logFile: path.join(root, "install.log"),
      budgetMs: 20,
      stallMs: 300,
      progressRoots: [store],
      report: (message) => {
        messages.push(message);
      },
    }),
  ).toBe(0);
  expect(messages.join("")).toContain("::warning");
  expect(messages.join("")).not.toContain("class=install-stall");
});

test("external installer termination preserves the platform signal evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ci-install-signal-"));
  roots.push(root);
  const messages: string[] = [];
  expect(
    await runLoggedInstall({
      command: [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'],
      logFile: path.join(root, "install.log"),
      progressRoots: [],
      report: (message) => {
        messages.push(message);
      },
    }),
  ).not.toBe(0);
  const reported = messages.join("");
  expect(reported).not.toContain("class=install-stall");
  if (process.platform === "win32") {
    // Windows Bun reports self-SIGTERM as an ordinary exit without signal metadata.
    expect(reported).toContain("Install finished; exit 1; signal none;");
    expect(reported).not.toContain("class=install-signal");
    return;
  }
  expect(reported).toContain("kind=infra class=install-signal");
  expect(reported).toContain("signal=SIGTERM");
});
