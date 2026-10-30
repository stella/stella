import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCacheWorker } from "./ci-cache";

const fixture = async (
  source: string,
  operation: "restore" | "save",
  stallMs = 1000,
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-cache-"));
  const entry = path.join(directory, "worker.js");
  writeFileSync(entry, source);
  try {
    return await runCacheWorker({ operation, entry, stallMs });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test("a 429 on restore becomes a cache miss with exit zero", async () => {
  expect(
    await fixture(
      "console.error('Rate limited: GetCacheEntryDownloadURL (HTTP 429)'); process.exit(1)",
      "restore",
    ),
  ).toBe(0);
});

test("the default Node runtime executes a cache bundle that mixes import and exports", async () => {
  expect(
    await fixture(
      "globalThis.exports = {}; import fs from 'node:fs'; exports.loaded = fs !== undefined",
      "restore",
    ),
  ).toBe(0);
});

test("a stalled save emits typed infrastructure skip telemetry with exit zero", async () => {
  const messages: string[] = [];
  const original = console.log;
  console.log = (message) => {
    messages.push(String(message));
  };
  try {
    expect(await fixture("setInterval(() => {}, 1000)", "save", 50)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(messages).toContain(
    "::warning title=cache-save-skipped::kind=infra class=cache-save outcome=skipped reason=stalled idle_ms=50",
  );
});

test("a corrupt restored archive still fails", async () => {
  expect(
    await fixture(
      "console.error('Failed to extract cache: invalid archive'); process.exit(1)",
      "restore",
    ),
  ).toBe(1);
});

test("a stalled restore stops its whole process tree before reporting a miss", async () => {
  if (process.platform === "win32") {
    return;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "ci-cache-tree-"));
  const destination = path.join(directory, "restore-output");
  const pidFile = path.join(directory, "descendant-pid");
  const entry = path.join(directory, "worker.cjs");
  writeFileSync(
    entry,
    `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(
        "const fs=require('node:fs'); const file=process.argv[1]; setInterval(() => fs.appendFileSync(file, 'payload'), 10)",
      )}, ${JSON.stringify(destination)}], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `,
  );
  try {
    expect(
      await runCacheWorker({ operation: "restore", entry, stallMs: 150 }),
    ).toBe(0);
    const descendantPid = Number(readFileSync(pidFile, "utf-8"));
    const sizeAfterResolve = statSync(destination).size;
    // real-time: the assertion proves no descendant can resume writes after resolution.
    await Bun.sleep(100);
    expect(statSync(destination).size).toBe(sizeAfterResolve);
    const status = Bun.spawnSync([
      "ps",
      "-o",
      "stat=",
      "-p",
      String(descendantPid),
    ]);
    expect(new TextDecoder().decode(status.stdout).trim()).toMatch(/^Z|^$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
