import { describe, expect, test } from "bun:test";

import { SlowCheckpointFolders } from "./slow-folders";

const SLOW = { status: "unavailable", reason: "too_slow" } as const;
const TAKEN = { status: "taken" } as const;
const HOUR = 60 * 60_000;

describe("a folder too slow to save", () => {
  test("is skipped after two slow captures in a row, for an hour", () => {
    const folders = new SlowCheckpointFolders();
    folders.record("/share", SLOW, 0);
    expect(folders.skips("/share", 1)).toBe(false);
    folders.record("/share", SLOW, 10);
    expect(folders.skips("/share", 11)).toBe(true);
    expect(folders.skips("/share", 10 + HOUR - 1)).toBe(true);
    // Tried again once the hour is up; still slow, skipped again at once.
    expect(folders.skips("/share", 10 + HOUR)).toBe(false);
    folders.record("/share", SLOW, 10 + HOUR);
    expect(folders.skips("/share", 11 + HOUR)).toBe(true);
    // Another folder is not affected.
    expect(folders.skips("/desk", 11)).toBe(false);
  });

  test("is measured afresh once a capture is taken or fails for another reason", () => {
    const folders = new SlowCheckpointFolders();
    folders.record("/share", SLOW, 0);
    folders.record("/share", TAKEN, 1);
    folders.record("/share", SLOW, 2);
    expect(folders.skips("/share", 3)).toBe(false);
    folders.record("/share", { status: "unavailable", reason: "too_large" }, 4);
    folders.record("/share", SLOW, 5);
    expect(folders.skips("/share", 6)).toBe(false);
  });
});
