import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseTestStateBaseline,
  validateTestStateBaselineFiles,
} from "./check-test-state-baseline.ts";
import { addedEntries } from "./ledger-membership.ts";

const FILE = "apps/api/src/lib/provider.test.ts";
const OTHER_FILE = "apps/api/src/lib/config.test.ts";
const metadata = {
  count: 2,
  owner: "guards",
  reason: "Migrate restoring fixtures",
};

test.each([
  ["missing count", { owner: "guards", reason: "Restore" }, "count"],
  ["zero count", { ...metadata, count: 0 }, "count"],
  ["negative count", { ...metadata, count: -1 }, "count"],
  ["fractional count", { ...metadata, count: 1.5 }, "count"],
  ["string count", { ...metadata, count: "2" }, "count"],
  [
    "unsafe count",
    { ...metadata, count: Number.MAX_SAFE_INTEGER + 1 },
    "count",
  ],
  ["missing owner", { count: 2, reason: "Restore" }, "owner"],
  ["blank owner", { ...metadata, owner: " \t" }, "owner"],
  ["nonstring owner", { ...metadata, owner: 2 }, "owner"],
  ["missing reason", { count: 2, owner: "guards" }, "reason"],
  ["blank reason", { ...metadata, reason: " \n" }, "reason"],
  ["nonstring reason", { ...metadata, reason: [] }, "reason"],
] as const)("rejects baseline metadata with %s", (_name, entry, field) => {
  expect(() =>
    parseTestStateBaseline(JSON.stringify({ [FILE]: entry }), "baseline"),
  ).toThrow(`${FILE} ${field}`);
});

test.each([[null], [[]], ["baseline"], [2]] as const)(
  "rejects a nonobject baseline %j",
  (value) => {
    expect(() =>
      parseTestStateBaseline(JSON.stringify(value), "baseline"),
    ).toThrow("must be an object keyed by repository test filename");
  },
);

test.each([
  "/absolute.test.ts",
  "../outside.test.ts",
  "apps/./provider.test.ts",
  "apps//provider.test.ts",
  "apps\\provider.test.ts",
  "C:/provider.test.ts",
  "apps/api/src/provider.ts",
  "apps/api/src/provider.test.ts/",
])("rejects invalid repository test filename %s", (file) => {
  expect(() =>
    parseTestStateBaseline(JSON.stringify({ [file]: metadata }), "baseline"),
  ).toThrow("must be a repository-relative test filename");
});

test("state access budgets only shrink within each existing file", () => {
  const base = parseTestStateBaseline(
    JSON.stringify({ [FILE]: metadata }),
    "base",
  );
  const shrink = parseTestStateBaseline(
    JSON.stringify({ [FILE]: { ...metadata, count: 1 } }),
    "current",
  );
  const grow = parseTestStateBaseline(
    JSON.stringify({ [FILE]: { ...metadata, count: 3 } }),
    "current",
  );
  const swap = parseTestStateBaseline(
    JSON.stringify({ [OTHER_FILE]: metadata }),
    "current",
  );
  expect(addedEntries(shrink, base)).toEqual([]);
  expect(addedEntries([], base)).toEqual([]);
  expect(addedEntries(grow, base)).toEqual([`${FILE}::3`]);
  expect(addedEntries(swap, base)).toEqual([
    `${OTHER_FILE}::1`,
    `${OTHER_FILE}::2`,
  ]);
  expect(addedEntries([...base, ...swap], base)).toEqual(swap);
  expect(addedEntries(base, null)).toEqual([]);
});

test("current baselines reject missing, untracked and nonregular test files", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "test-state-baseline-"));
  const directory = path.join(repoRoot, path.dirname(FILE));
  const members = parseTestStateBaseline(
    JSON.stringify({ [FILE]: metadata }),
    "baseline",
  );
  const trackedFiles = new Set([FILE]);
  const validate = () =>
    validateTestStateBaselineFiles({ members, repoRoot, trackedFiles });
  const failure = `${FILE} must exist as a regular tracked test file; delete its baseline entry`;
  try {
    mkdirSync(directory, { recursive: true });
    expect(validate).toThrow(failure);
    writeFileSync(path.join(repoRoot, FILE), "test fixture");
    expect(validate()).toBeUndefined();
    expect(() =>
      validateTestStateBaselineFiles({
        members,
        repoRoot,
        trackedFiles: new Set(),
      }),
    ).toThrow(failure);
    rmSync(path.join(repoRoot, FILE));
    mkdirSync(path.join(repoRoot, FILE));
    expect(validate).toThrow(failure);
    rmSync(path.join(repoRoot, FILE), { recursive: true });
    writeFileSync(path.join(repoRoot, OTHER_FILE), "test fixture");
    symlinkSync(path.join(repoRoot, OTHER_FILE), path.join(repoRoot, FILE));
    expect(validate).toThrow(failure);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
