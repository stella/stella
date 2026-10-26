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

import {
  createInstallWatchdog,
  installStoreProgress,
  installWarningBudgetMs,
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

test("failed and hung installers preserve output and never retry", async () => {
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
  expect(hung.match(/Install started/gu)).toHaveLength(1);
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
      `restore=${restoreOutcome} key=${restoreOutcome === "hit" ? "test-key" : "unavailable"}`,
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
