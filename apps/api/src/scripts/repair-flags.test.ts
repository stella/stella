/**
 * What an operator types has to mean what they meant. These flags bound a run
 * that writes, so a spelling the reader does not recognise is not a cosmetic
 * miss: an unread `--limit` leaves the caller's default standing, and the
 * default is thousands of rows.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  flagInteger,
  hasFlag,
  readApplyFlag,
  rejectUnknownFlags,
} from "@/api/scripts/repair-flags";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

const withArgs = (...args: string[]): void => {
  process.argv = ["bun", "repair.ts", ...args];
};

const limit = (): number =>
  flagInteger({ fallback: 5000, name: "limit", usage: "usage" });

describe("flagInteger", () => {
  test("reads the spelling the usage texts document", () => {
    withArgs("--apply", "--limit", "10");
    expect(limit()).toBe(10);
  });

  test("reads the inline spelling a shell user reaches for", () => {
    withArgs("--apply", "--limit=10");
    expect(limit()).toBe(10);
  });

  test("falls back only when the flag is absent altogether", () => {
    withArgs("--apply");
    expect(limit()).toBe(5000);
  });

  test("does not read one flag's value off another's name", () => {
    withArgs("--limit=7", "--batch=9");
    expect(limit()).toBe(7);
    expect(flagInteger({ fallback: 1, name: "batch", usage: "usage" })).toBe(9);
  });
});

describe("readApplyFlag", () => {
  test("a run writes only when it was asked to", () => {
    withArgs("--limit=10");
    expect(readApplyFlag("usage")).toBe(false);
    withArgs("--apply", "--limit=10");
    expect(readApplyFlag("usage")).toBe(true);
  });

  test("the inline spelling of another flag is not an apply", () => {
    withArgs("--dry-run", "--limit=10");
    expect(hasFlag("apply")).toBe(false);
    expect(readApplyFlag("usage")).toBe(false);
  });
});

/** How a stubbed `process.exit` stops its caller, since the real one does not return. */
class ProcessExitedError extends Error {
  constructor() {
    super("process.exit");
    this.name = "ProcessExitedError";
  }
}

/**
 * The exit code a reader took instead of answering, or `"returned"` when it
 * answered. A reader that rejects an argument ends the run, so what it does
 * with a bad spelling cannot be observed through its return value.
 */
const exitedWith = (read: () => unknown): number | "returned" => {
  let code: number | "returned" = "returned";
  const exit = spyOn(process, "exit").mockImplementation((value) => {
    code = typeof value === "number" ? value : 0;
    throw new ProcessExitedError();
  });
  const silenced = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    read();
  } catch (error) {
    // Anything else is a real failure of the reader under test.
    if (!(error instanceof ProcessExitedError)) {
      throw error;
    }
  } finally {
    exit.mockRestore();
    silenced.mockRestore();
  }
  return code;
};

describe("a stated flag takes no value", () => {
  test("an assigned --apply does not quietly become a report", () => {
    // The name alone is recognised, so the value would be dropped and the run
    // would report — the opposite of what was asked for, and silently.
    withArgs("--apply=true", "--limit=10");
    expect(exitedWith(() => readApplyFlag("usage"))).toBe(1);
  });

  test("an assigned --dry-run is refused on its own", () => {
    // Nobody passes this one beside --apply, so a reader that only looked
    // while --apply was present would never look at all.
    withArgs("--dry-run=false");
    expect(exitedWith(() => readApplyFlag("usage"))).toBe(1);
  });

  test("the bare spellings still read", () => {
    withArgs("--apply", "--limit=10");
    expect(readApplyFlag("usage")).toBe(true);
    withArgs("--dry-run", "--limit=10");
    expect(readApplyFlag("usage")).toBe(false);
  });
});

describe("rejectUnknownFlags", () => {
  const reject = (): void =>
    rejectUnknownFlags({ known: ["limit", "page"], usage: "usage" });

  test("a flag this repair does not have stops the run", () => {
    // The command an earlier revision documented, repeated after the flag was
    // removed: accepting it silently would widen the run.
    withArgs("--apply", "--adapter=cz-us");
    expect(exitedWith(reject)).toBe(1);
    withArgs("--apply", "--after", "some-id");
    expect(exitedWith(reject)).toBe(1);
  });

  test("a flag it does have, in either spelling, passes", () => {
    withArgs("--apply", "--limit", "10", "--page=500");
    expect(exitedWith(reject)).toBe("returned");
  });
});
