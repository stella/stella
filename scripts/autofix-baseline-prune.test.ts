import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  PRUNABLE_BASELINE_WRITERS,
  PRUNABLE_BASELINES,
  pruneViolations,
} from "./autofix-baseline-prune";
import { isAutofixProtectedPath } from "./autofix-protected-paths";
import { BASELINE_PATHS } from "./baseline-paths";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const atPath = (value: unknown, collection: readonly string[]): unknown => {
  let current = value;
  for (const key of collection) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
};

test("only protected, registered baselines are prunable", () => {
  const registered = new Set<string>(Object.values(BASELINE_PATHS));
  for (const { path } of PRUNABLE_BASELINES) {
    expect(registered.has(path), path).toBe(true);
    // Protection stays the default; pruning is an exception the workflow
    // grants after verification, never a removal from the protected list.
    expect(isAutofixProtectedPath(path), path).toBe(true);
  }
  expect(new Set(PRUNABLE_BASELINES.map(({ path }) => path)).size).toBe(
    PRUNABLE_BASELINES.length,
  );
  for (const { write } of PRUNABLE_BASELINE_WRITERS) {
    expect(readFileSync(write[1], "utf-8").length).toBeGreaterThan(0);
  }
});

test("each committed baseline exposes its entries where the registry says", () => {
  for (const { path, collection } of PRUNABLE_BASELINES) {
    const text = readFileSync(path, "utf-8");
    const entries = atPath(JSON.parse(text), collection);
    expect(typeof entries === "object" && entries !== null, path).toBe(true);
    expect(pruneViolations(path, text, text), path).toEqual([]);
  }
});

test("deleting a committed entry is applied and adding one is refused", () => {
  let exercised = 0;
  for (const { path, collection } of PRUNABLE_BASELINES) {
    const text = readFileSync(path, "utf-8");
    const document: unknown = JSON.parse(text);
    const entries = atPath(document, collection);
    const replace = (next: unknown) =>
      JSON.stringify(
        collection.length === 0 || !isRecord(document)
          ? next
          : { ...document, [collection.join(".")]: next },
        null,
        2,
      );
    if (Array.isArray(entries)) {
      const first: unknown = entries[0];
      if (first === undefined) {
        continue;
      }
      expect(
        pruneViolations(path, text, replace(entries.slice(1))),
        path,
      ).toEqual([]);
      expect(
        pruneViolations(path, text, replace([...entries, first])),
        path,
      ).not.toEqual([]);
      exercised += 1;
    } else if (typeof entries === "object" && entries !== null) {
      const keys = Object.keys(entries);
      const [firstKey] = keys;
      if (firstKey === undefined) {
        continue;
      }
      const rest = Object.fromEntries(
        Object.entries(entries).filter(([key]) => key !== firstKey),
      );
      expect(pruneViolations(path, text, replace(rest)), path).toEqual([]);
      expect(
        pruneViolations(
          path,
          text,
          replace({
            ...entries,
            "autofix-test::new-entry": Reflect.get(entries, firstKey),
          }),
        ),
        path,
      ).not.toEqual([]);
      exercised += 1;
    }
  }
  expect(exercised).toBeGreaterThanOrEqual(4);
});

test("an unregistered baseline is never prunable", () => {
  expect(pruneViolations(BASELINE_PATHS.bundle, '{"a":1}', "{}")).toEqual([
    `${BASELINE_PATHS.bundle} is not a shrink-only baseline`,
  ]);
  expect(pruneViolations(".changeset/release.md", "x", "")).not.toEqual([]);
});
