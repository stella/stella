import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState, waitForFileContent } from "./external-state.ts";
import { rejectionOf } from "./rejection.ts";

describe("waitForExternalState", () => {
  test("returns the first read that holds", async () => {
    const reads = [undefined, null, false, "ready", "later"];
    const state = await waitForExternalState({
      description: "the fixture state",
      read: () => reads.shift(),
      intervalMs: 0,
    });
    expect(state).toBe("ready");
    expect(reads).toEqual(["later"]);
  });

  test("awaits asynchronous reads", async () => {
    let calls = 0;
    const state = await waitForExternalState({
      description: "the third read",
      read: async () => {
        calls += 1;
        return await Promise.resolve(calls === 3);
      },
      intervalMs: 0,
    });
    expect(state).toBe(true);
    expect(calls).toBe(3);
  });

  test("fails with the description once the budget is spent", async () => {
    let calls = 0;
    const failure = await rejectionOf(
      waitForExternalState({
        description: "backend 42 waits on a lock",
        read: () => {
          calls += 1;
          return false;
        },
        intervalMs: 0,
        timeoutMs: 0,
      }),
    );
    expect(failure).toBeInstanceOf(Panic);
    expect(String(failure)).toContain("backend 42 waits on a lock");
    expect(calls).toBe(1);
  });

  test("returns the fallback once the budget is spent when one is given", async () => {
    const state = await waitForExternalState({
      description: "a state that never holds",
      read: () => false,
      intervalMs: 0,
      timeoutMs: 0,
      onTimeout: () => "gave up" as const,
    });
    expect(state).toBe("gave up");
  });
});

describe("waitForFileContent", () => {
  const fixture = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "file-content-wait-"));
    return {
      directory,
      file: path.join(directory, "announced"),
      [Symbol.dispose]: () => {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  };
  const threePids = (content: string) => {
    if (!content.endsWith("\n")) {
      return undefined;
    }
    const pids = content.trim().split(" ").map(Number);
    return pids.length === 3 && pids.every((pid) => pid > 1) ? pids : undefined;
  };

  test("waits past a created, empty or partial file until the content parses", async () => {
    using files = fixture();
    // A writer creates the file before it writes, then writes in parts.
    writeFileSync(files.file, "");
    const stages = ["41", "41 42 4", "41 42 43\n"];
    const seen: string[] = [];
    const pids = await waitForFileContent({
      description: "the writer announces three pids",
      path: files.file,
      parse: (content) => {
        seen.push(content);
        const next = stages.shift();
        if (next !== undefined) {
          writeFileSync(files.file, next);
        }
        return threePids(content);
      },
      intervalMs: 0,
    });
    expect(pids).toEqual([41, 42, 43]);
    expect(seen).toEqual(["", "41", "41 42 4", "41 42 43\n"]);
  });

  test("keeps waiting while the file is missing and reads it once written", async () => {
    using files = fixture();
    // The first read runs before the wait yields, while the file is missing.
    const waiting = waitForFileContent({
      description: "the writer announces three pids",
      path: files.file,
      parse: threePids,
      intervalMs: 0,
    });
    writeFileSync(files.file, "41 42 43\n");
    expect(await waiting).toEqual([41, 42, 43]);
  });

  test("a missing file is not yet announced", async () => {
    using files = fixture();
    const state = await waitForFileContent({
      description: "a file nobody writes",
      path: files.file,
      parse: () => "parsed" as const,
      intervalMs: 0,
      timeoutMs: 0,
      onTimeout: () => "absent" as const,
    });
    expect(state).toBe("absent");
  });

  test("any other read failure ends the wait", async () => {
    using files = fixture();
    const failure = await rejectionOf(
      waitForFileContent({
        description: "a directory read as a file",
        path: files.directory,
        parse: () => "parsed" as const,
        intervalMs: 0,
      }),
    );
    expect(failure).toBeInstanceOf(Panic);
    expect(String(failure)).toContain(files.directory);
  });
});
