import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runLoggedInstall } from "./ci-install";

const roots: string[] = [];
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
      timeoutMs: 500,
    }),
  ).not.toBe(0);
  const hung = readFileSync(logFile, "utf-8");
  expect(hung).toContain("partial output before hang");
  expect(hung).toContain("Install finished;");
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
