import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GUARD_ROLLOUT_DIRECTORY,
  GUARD_ROLLOUTS,
  type GuardRollout,
  guardRolloutsFromFiles,
  guardRolloutSource,
} from "./guard-rollout-policy.ts";
import {
  changedLineNumbers,
  guardEnforcesLine as productionGuardEnforcesLine,
} from "./guard-rollouts.ts";

const guardEnforcesLine = (
  options: Parameters<typeof productionGuardEnforcesLine>[0],
) =>
  productionGuardEnforcesLine({
    ...options,
    rollouts: [
      {
        id: "portable-path",
        type: "changed-lines",
        expiresAt: "2026-10-20T00:00:00.000Z",
        check: ["bun", "scripts/check-fixture.ts"],
      },
      ...GUARD_ROLLOUTS.filter(({ id }) => id !== "portable-path"),
    ],
  });

test("diff scope excludes deletion hunks and includes every inserted line", () => {
  expect([
    ...changedLineNumbers("@@ -1,2 +1,0 @@\n@@ -8 +7,2 @@\n@@ -12 +13 @@"),
  ]).toEqual([7, 8, 13]);
});

const ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURES = ".oxlint-plugins/__fixtures__";
const readFixtures = (directory: string) =>
  readdirSync(path.join(ROOT, directory), {
    encoding: "utf-8",
    recursive: true,
  })
    .filter((name) => /\.fixture\.tsx?$/u.test(name))
    .map((name) => {
      const file = `${directory}/${name}`;
      return { file, source: readFileSync(path.join(ROOT, file), "utf-8") };
    });

const fixtures = readFixtures(FIXTURES);

test("fixture discovery reads .fixture.tsx files", () => {
  const directory = mkdtempSync(path.join(ROOT, ".fixture-discovery-"));
  try {
    writeFileSync(path.join(directory, "rule.fixture.tsx"), "tsx");
    writeFileSync(path.join(directory, "rule.fixture.ts"), "ts");
    writeFileSync(path.join(directory, "rule.ts"), "other");
    expect(
      readFixtures(path.basename(directory))
        .map(({ source }) => source)
        .toSorted(),
    ).toEqual(["ts", "tsx"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const { id: guard, rules = [] } of GUARD_ROLLOUTS) {
  for (const rule of rules) {
    test(`${rule} enforces every violating fixture line without changed lines`, () => {
      let violations = 0;
      for (const { file, source } of fixtures) {
        for (const [index, line] of source.split("\n").entries()) {
          if (
            !line.includes("oxlint-disable-next-line") ||
            !line.includes(rule)
          ) {
            continue;
          }
          violations++;
          for (const fixturePath of [file, path.join(ROOT, file)]) {
            expect(
              guardEnforcesLine({
                guard,
                file: fixturePath,
                line: index + 2,
                now: new Date("2026-10-14T00:00:00.000Z"),
                changedLines: new Map(),
              }),
            ).toBe(true);
          }
        }
      }
      expect(violations).toBeGreaterThan(0);
    });
  }
}

test("fixture scope does not include similarly named directories", () => {
  expect(
    guardEnforcesLine({
      guard: "portable-path",
      file: `${FIXTURES}-other/path.ts`,
      line: 1,
      now: new Date("2026-10-14T00:00:00.000Z"),
      changedLines: new Map(),
    }),
  ).toBe(false);
});

test("first-week path enforcement ignores legacy lines and expires into full scope", () => {
  const changedLines = new Map([["scripts/path.ts", new Set([4])]]);
  const options = {
    guard: "portable-path",
    file: "scripts/path.ts",
    changedLines,
  };
  const now = new Date("2026-10-14T00:00:00.000Z");
  expect(guardEnforcesLine({ ...options, line: 3, now })).toBe(false);
  expect(guardEnforcesLine({ ...options, line: 4, now })).toBe(true);
  expect(
    guardEnforcesLine({
      ...options,
      line: 3,
      now: new Date("2026-10-20T00:00:00.000Z"),
    }),
  ).toBe(true);
});

const fullRollout = (id: string): GuardRollout => ({
  id,
  type: "full",
  check: ["bun", `scripts/check-${id}.ts`],
});

test("discovery loads every rollout in file name order", () => {
  expect(GUARD_ROLLOUTS.map(({ id }) => guardRolloutSource(id))).toEqual(
    readdirSync(path.join(ROOT, GUARD_ROLLOUT_DIRECTORY))
      .filter((file) => file.endsWith(".json"))
      .toSorted()
      .map((file) => `${GUARD_ROLLOUT_DIRECTORY}/${file}`),
  );
});

const withRolloutRepo = (run: (root: string) => void) => {
  const root = mkdtempSync(path.join(tmpdir(), "guard-rollouts-"));
  try {
    mkdirSync(path.join(root, GUARD_ROLLOUT_DIRECTORY), { recursive: true });
    copyFileSync(
      path.join(ROOT, "scripts/guard-rollout-policy.ts"),
      path.join(root, "scripts/guard-rollout-policy.ts"),
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const loadRollouts = (root: string) =>
  spawnSync(
    process.execPath,
    [
      "-e",
      'import { GUARD_ROLLOUT_FILES, GUARD_ROLLOUTS } from "./scripts/guard-rollout-policy.ts"; console.log(JSON.stringify({ files: GUARD_ROLLOUT_FILES, rollouts: GUARD_ROLLOUTS }));',
    ],
    { cwd: root, encoding: "utf-8", maxBuffer: 2 ** 20 },
  );

test("parallel rollout branches merge cleanly and both load without an install", () => {
  withRolloutRepo((root) => {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 2 ** 20,
      }).trim();
    git("init", "-b", "base");
    git("config", "user.name", "Rollout fixture");
    git("config", "user.email", "rollout@example.test");
    writeFileSync(path.join(root, GUARD_ROLLOUT_DIRECTORY, ".gitkeep"), "");
    git("add", ".");
    git("commit", "-m", "fixture base");
    // Add in reverse lexical order so discovery must establish its own order.
    for (const id of ["z-guard", "a-guard"]) {
      git("switch", "-c", id, "base");
      writeFileSync(
        path.join(root, guardRolloutSource(id)),
        JSON.stringify(fullRollout(id)),
      );
      git("add", ".");
      git("commit", "-m", `add ${id}`);
    }
    expect(git("merge-tree", "--write-tree", "a-guard", "z-guard")).toMatch(
      /^[a-f0-9]{40,64}$/u,
    );
    git("merge", "--no-edit", "z-guard");
    const loaded = loadRollouts(root);
    expect(loaded.status).toBe(0);
    expect(loaded.stderr).toBe("");
    expect(JSON.parse(loaded.stdout)).toEqual({
      files: {
        "a-guard": fullRollout("a-guard"),
        "z-guard": fullRollout("z-guard"),
      },
      rollouts: [fullRollout("a-guard"), fullRollout("z-guard")],
    });
  });
});

test.each([
  { label: "invalid JSON", source: "{" },
  { label: "null rollout", source: "null" },
  { label: "missing fields", source: '{ "id": "bad-guard" }' },
  {
    label: "unknown type",
    source: '{ "id": "bad-guard", "type": "other", "check": [] }',
  },
  {
    label: "invalid check",
    source: '{ "id": "bad-guard", "type": "full", "check": [1] }',
  },
  {
    label: "invalid rules",
    source:
      '{ "id": "bad-guard", "type": "full", "check": [], "rules": "rule" }',
  },
  {
    label: "missing expiry",
    source: '{ "id": "bad-guard", "type": "changed-lines", "check": [] }',
  },
  {
    label: "missing generator",
    source: '{ "id": "bad-guard", "type": "autofix", "check": [] }',
  },
  {
    label: "mismatched id",
    source: '{ "id": "other", "type": "full", "check": [] }',
  },
  {
    label: "invalid syntax",
    source: "not json",
  },
])("a bad rollout panics with its path: $label", ({ source }) => {
  withRolloutRepo((root) => {
    const file = guardRolloutSource("bad-guard");
    writeFileSync(path.join(root, file), source);
    const loaded = loadRollouts(root);
    expect(loaded.status).not.toBe(0);
    expect(loaded.stderr).toContain(file);
    expect(loaded.stderr).toContain("AssertionError");
  });
});

test.each(["Guard.json", "a-1.json", "a--b.json", "1a.json"])(
  "an invalid rollout filename panics with its path: %s",
  (file) => {
    withRolloutRepo((root) => {
      const source = `${GUARD_ROLLOUT_DIRECTORY}/${file}`;
      writeFileSync(path.join(root, source), "{}");
      const loaded = loadRollouts(root);
      expect(loaded.status).not.toBe(0);
      expect(loaded.stderr).toContain(source);
      expect(loaded.stderr).toContain("AssertionError");
    });
  },
);

test("rollouts from separate files preserve registry order", () => {
  expect(
    guardRolloutsFromFiles({
      "a-guard": fullRollout("a-guard"),
      "z-guard": fullRollout("z-guard"),
    }),
  ).toEqual([fullRollout("a-guard"), fullRollout("z-guard")]);
});

test("a rollout whose file name differs from its id panics", () => {
  expect(() =>
    guardRolloutsFromFiles({ renamed: fullRollout("a-guard") }),
  ).toThrow("guard rollout filename must match id: renamed.json (a-guard)");
});

test("a duplicate rollout id panics through the file name contract", () => {
  expect(() =>
    guardRolloutsFromFiles({
      "a-guard": fullRollout("a-guard"),
      "b-guard": fullRollout("a-guard"),
    }),
  ).toThrow("guard rollout filename must match id: b-guard.json (a-guard)");
});
