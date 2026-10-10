import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CANONICAL_JSON_PATHS,
  ORDER_MEANINGFUL_JSON,
  SHARED_LEDGER_PATHS,
  canonicalJsonOrderError,
} from "./shared-json-ledgers";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SHARED_LEDGER_NAME =
  /(?:-ledger|\.allowlist|-exceptions|suppression-waivers)\.json$/u;

const trackedFiles = (): string[] => {
  const result = Bun.spawnSync(["git", "ls-files"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\n").filter(Boolean);
};

test("every shared JSON ledger is classified", () => {
  const discovered = trackedFiles().filter(
    (file) =>
      /^(?:scripts|\.oxlint-plugins|apps\/api)\//u.test(file) &&
      SHARED_LEDGER_NAME.test(file),
  );
  const classified = new Set([
    ...SHARED_LEDGER_PATHS,
    ...Object.keys(ORDER_MEANINGFUL_JSON),
  ]);

  expect(
    discovered.filter((file) => !classified.has(file)),
    "Add each new shared ledger to SHARED_LEDGER_PATHS, or document why order is meaningful in ORDER_MEANINGFUL_JSON.",
  ).toEqual([]);
});

test("canonical shared JSON files retain deterministic entry order", () => {
  const errors = CANONICAL_JSON_PATHS.flatMap((file) => {
    const value: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, file), "utf-8"),
    );
    const error = canonicalJsonOrderError(value);
    return error === null ? [] : [`${file}: ${error}; sort the stable keys`];
  });

  expect(errors).toEqual([]);
});

test("an out-of-order shared ledger is not canonical", () => {
  expect(canonicalJsonOrderError([{ id: "z" }, { id: "a" }])).toBe(
    "array entries must be sorted and duplicate-free by id",
  );
});

test("order exceptions remain reasoned", () => {
  expect(
    Object.entries(ORDER_MEANINGFUL_JSON).filter(
      ([, reason]) => reason.trim().length === 0,
    ),
  ).toEqual([]);
});
