import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_ROOT = path.join(import.meta.dir, "..");

/**
 * Where a raw change count may be read. A list keyed on it remounts on every
 * change, so its spinner flashes over the list and its state resets; lists
 * reload in place through `useRevisedLoad` instead. The Live Activity sync
 * renders nothing, so remounting it shows nothing.
 */
const RAW_REVISION_READERS = new Set([
  "components/changes.tsx",
  "components/timer-activity-sync.tsx",
]);

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [full]
      : [];
  });

describe("lists that follow changes", () => {
  test("reload in place, never remount on a change count", () => {
    const readers = sources(SOURCE_ROOT)
      .filter((file) => readFileSync(file, "utf-8").includes("useRevision("))
      .map((file) =>
        file
          .slice(SOURCE_ROOT.length + 1)
          .split(path.sep)
          .join("/"),
      )
      .toSorted();
    expect(readers).toEqual([...RAW_REVISION_READERS].toSorted());
  });
});
