import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import { installTimeoutMs, runLoggedInstall } from "./ci-install";

const roots: string[] = [];
test("Windows installs retain cold-install headroom regardless of cache contents", () => {
  expect(installTimeoutMs("win32")).toBe(240_000);
  expect(installTimeoutMs("linux")).toBe(120_000);
  expect(installTimeoutMs("darwin")).toBe(120_000);
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

class InstallRecordingFixtureError extends Error {
  override name = "InstallRecordingFixtureError";
  readonly _tag = "InstallRecordingFixtureError";
}

test("a failed recorder kills and reaps an installer that is still alive", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "install-recording-failure-"));
  roots.push(root);
  let installerPid: number | undefined;
  try {
    const failure = await rejectionOf(
      runLoggedInstall({
        command: [
          process.execPath,
          "-e",
          `console.log(\`live installer \${process.pid}\`); setInterval(() => {}, 1000)`,
        ],
        logFile: path.join(root, "install.log"),
        report: () => {},
        writeLog: (descriptor, chunk) => {
          const match = /live installer (\d+)/u.exec(
            Buffer.from(chunk).toString(),
          );
          if (match?.[1]) {
            installerPid = Number(match[1]);
            process.kill(installerPid, 0);
            throw new InstallRecordingFixtureError("Fixture log write failure");
          }
          writeSync(descriptor, chunk);
        },
      }),
    );
    expect(failure).toBeInstanceOf(InstallRecordingFixtureError);
    expect(failure).toMatchObject({ message: "Fixture log write failure" });
    if (installerPid === undefined) {
      expect.unreachable(
        "The fixture must reach recording with a live installer",
      );
    }
    const stoppedPid = installerPid;
    expect(() => process.kill(stoppedPid, 0)).toThrow(/ESRCH|No such process/u);
  } finally {
    if (installerPid !== undefined) {
      try {
        process.kill(installerPid, "SIGKILL");
      } catch (error) {
        expect(error).toMatchObject({ code: "ESRCH" });
      }
    }
  }
});

test.skipIf(process.platform === "win32")(
  "Linux timeout diagnostics select the installer descendants and capture store capacity",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "install-diagnostic-"));
    roots.push(root);
    const bin = path.join(root, "bin");
    const store = path.join(root, "store");
    mkdirSync(bin);
    mkdirSync(store);
    const commands = {
      ps: "printf '%s\\n' '1000 1 S futex_wait bun' '1001 1000 S wait worker' '2000 1 S wait unrelated'",
      cat: 'printf "proc read: %s\\n" "$*"',
      df: 'printf "filesystem snapshot: %s\\n" "$*"',
      find: 'printf "123 fixture.tmp-unfinished\\n"',
    };
    for (const [name, body] of Object.entries(commands)) {
      const filename = path.join(bin, name);
      writeFileSync(filename, `#!/bin/sh\n${body}\n`);
      chmodSync(filename, 0o755);
    }
    const result = Bun.spawnSync(
      [
        "bash",
        path.join(import.meta.dir, "ci-install-timeout-diagnostics.sh"),
        "1000",
        store,
        root,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("1000 1 S futex_wait bun");
    expect(output).toContain("1001 1000 S wait worker");
    expect(output).not.toContain("unrelated");
    expect(output).toContain("/proc/1000/status /proc/1000/wchan");
    expect(output).toContain("/proc/1001/status /proc/1001/wchan");
    expect(output).toContain("Process 1000 open fd count: 0");
    expect(output).toContain(`filesystem snapshot: -h ${store} ${root}`);
    expect(output).toContain(`filesystem snapshot: -i ${store} ${root}`);
    expect(output).toContain("fixture.tmp-unfinished");
  },
);

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
      timeoutMs: 500,
      timeoutDiagnostics: (pid) => {
        process.kill(pid, 0);
        return "Live installer state captured\n";
      },
    }),
  ).not.toBe(0);
  const hung = readFileSync(logFile, "utf-8");
  expect(hung).toContain("partial output before hang");
  expect(hung).toContain("Install finished;");
  expect(hung).toContain("Live installer state captured");
  expect(hung).toContain("signal SIGKILL");
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
    expect(artifact).toContain("begin evidence");
    expect(artifact).toContain("last diagnostic");
    expect(artifact.match(/verbose extraction/gu)).toHaveLength(10_000);
    expect(artifact.match(/Install started/gu)).toHaveLength(1);
    const reported = consoleOutput.join("");
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
