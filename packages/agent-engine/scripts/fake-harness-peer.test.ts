import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readCompleteLines, readFakeHarnessLog } from "./fake-harness-peer";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const logFile = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-fake-log-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "fake.log");
};

describe("reading a log its writer may still be appending to", () => {
  test("a log not yet created has no entries", () => {
    expect(readFakeHarnessLog(logFile())).toEqual([]);
  });

  test("a line still being written waits for its newline", () => {
    const log = logFile();
    writeFileSync(log, '{"startup":{"args":[]}}\n{"received":{"ty');
    expect(readFakeHarnessLog(log)).toEqual([{ startup: { args: [] } }]);
    writeFileSync(log, '{"startup":{"args":[]}}\n{"received":{"type":"x"}}\n');
    expect(readFakeHarnessLog(log)).toEqual([
      { startup: { args: [] } },
      { received: { type: "x" } },
    ]);
  });

  test("a log whose first line is unfinished has no lines yet", () => {
    const log = logFile();
    writeFileSync(log, '{"startup":');
    expect(readCompleteLines(log)).toEqual([]);
  });
});
