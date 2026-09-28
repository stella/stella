import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkStandaloneLockfiles,
  parseInstallCommands,
} from "./check-standalone-lockfiles";

const ROOT_BUNFIG = `
[install]
minimumReleaseAge = 432_000
minimumReleaseAgeExcludes = [
  "@stll/native",
]
`;

const DEPENDABOT_ROOT_ONLY = `
version: 2
updates:
  - package-ecosystem: "bun"
    directories:
      - "/"
    cooldown:
      default-days: 5
`;

const DEPENDABOT_COVERING = `
version: 2
updates:
  - package-ecosystem: "bun"
    directories:
      - "/"
      - "/tools/docs"
    cooldown:
      default-days: 5
`;

const ROOT_PACKAGE = JSON.stringify({
  name: "root",
  scripts: {
    "setup:docs": "bun install --cwd tools/docs --frozen-lockfile",
  },
});

const STANDALONE_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "zod": ["zod@4.4.3", "", {}, "sha512-test"],
  }
}`;

const QUARANTINED_BUNFIG = "[install]\nminimumReleaseAge = 432_000\n";

let roots: string[] = [];

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
  roots = [];
});

/** Writes a fixture repository and returns its root and file list. */
const fixture = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "standalone-lockfiles-"));
  roots.push(root);
  const all: Record<string, string> = {
    ".github/dependabot.yml": DEPENDABOT_COVERING,
    "bun.lock": "{}",
    "bunfig.toml": ROOT_BUNFIG,
    "package.json": ROOT_PACKAGE,
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return { root, trackedFiles: Object.keys(all) };
};

const withoutBunfig = {
  "tools/docs/bun.lock": STANDALONE_LOCK,
  "tools/docs/package.json": "{}",
};

const covered = {
  ...withoutBunfig,
  "tools/docs/bunfig.toml": QUARANTINED_BUNFIG,
};

describe("standalone lockfile guard", () => {
  test("passes a standalone lockfile that carries every safety net", () => {
    const result = checkStandaloneLockfiles(fixture(covered));

    expect(result.errors).toEqual([]);
    expect(result.covered).toEqual(["tools/docs/bun.lock"]);
  });

  test("fails a standalone lockfile with no bunfig and names the fix", () => {
    const result = checkStandaloneLockfiles(fixture(withoutBunfig));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toStartWith(
      "tools/docs/bun.lock is a standalone Bun lockfile missing 1 safety net(s):",
    );
    expect(result.errors[0]).toContain(
      "release-age quarantine: tools/docs/bunfig.toml does not exist",
    );
    expect(result.errors[0]).toContain(
      "Fix: add tools/docs/bunfig.toml with [install] minimumReleaseAge = 432000.",
    );
  });

  test("fails a bunfig whose quarantine is shorter than the root's", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "tools/docs/bunfig.toml": "[install]\nminimumReleaseAge = 86_400\n",
      }),
    );

    expect(result.errors[0]).toContain(
      "minimumReleaseAge 86400 is below the root's 432000",
    );
  });

  test("fails a lockfile with a bunfig but no Dependabot entry", () => {
    const result = checkStandaloneLockfiles(
      fixture({ ...covered, ".github/dependabot.yml": DEPENDABOT_ROOT_ONLY }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      "Dependabot cooldown: no bun update in .github/dependabot.yml covers /tools/docs.",
    );
  });

  test("fails a Dependabot entry whose cooldown is shorter than the quarantine", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        ".github/dependabot.yml": DEPENDABOT_COVERING.replace(
          "default-days: 5",
          "default-days: 1",
        ),
      }),
    );

    expect(result.errors[0]).toContain("has a cooldown below 5 days");
  });

  test("fails a lockfile nothing installs frozen", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "package.json": JSON.stringify({
          scripts: { "setup:docs": "bun install --cwd tools/docs" },
        }),
      }),
    );

    expect(result.errors[0]).toContain(
      'frozen install: installed without --frozen-lockfile in package.json "setup:docs".',
    );
  });

  test("fails a lockfile no script or workflow installs", () => {
    const result = checkStandaloneLockfiles(
      fixture({ ...covered, "package.json": "{}" }),
    );

    expect(result.errors[0]).toContain(
      "frozen install: no script or workflow installs this directory.",
    );
  });

  test("requires the root excludes the standalone lockfile resolves", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "tools/docs/bun.lock": STANDALONE_LOCK.replace(
          '"packages": {',
          '"packages": {\n    "@stll/native": ["@stll/native@1.0.0", "", {}, "sha512-test"],',
        ),
      }),
    );

    expect(result.errors[0]).toContain(
      "quarantine excludes: resolves root-excluded packages without excluding them: @stll/native.",
    );
  });

  test("rejects an exclude the root does not carry", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        "tools/docs/bunfig.toml": `${QUARANTINED_BUNFIG}minimumReleaseAgeExcludes = ["zod"]\n`,
      }),
    );

    expect(result.errors[0]).toContain(
      "quarantine excludes: excludes packages the root does not: zod.",
    );
  });

  test.each(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"])(
    "fails a stray %s",
    (lockfile) => {
      const result = checkStandaloneLockfiles(
        fixture({ [`tools/legacy/${lockfile}`]: "{}" }),
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toStartWith(
        `tools/legacy/${lockfile}: this lockfile bypasses the repository's release-age quarantine`,
      );
      expect(result.errors[0]).toContain("Delete it and install with Bun");
    },
  );

  test.each(["bun.lockb", "tools/docs/bun.lockb"])(
    "fails a binary lockfile at %s, whose packages cannot be checked",
    (lockfile) => {
      const result = checkStandaloneLockfiles(
        fixture({ ...covered, [lockfile]: "" }),
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toStartWith(
        `${lockfile}: a binary Bun lockfile cannot be checked`,
      );
    },
  );

  test("fails an unfrozen install in a workflow step's working directory", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        ".github/workflows/docs.yml": `
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - name: Install docs
        working-directory: tools/docs
        run: bun install
`,
      }),
    );

    expect(result.errors[0]).toContain(
      'installed without --frozen-lockfile in .github/workflows/docs.yml job "docs" step "Install docs"',
    );
  });

  test("resolves a job's default working directory", () => {
    const result = checkStandaloneLockfiles(
      fixture({
        ...covered,
        ".github/workflows/docs.yml": `
jobs:
  docs:
    defaults:
      run:
        working-directory: tools
    steps:
      - run: cd docs && bun install
`,
      }),
    );

    expect(result.errors[0]).toContain(
      'installed without --frozen-lockfile in .github/workflows/docs.yml job "docs" step "#1"',
    );
  });

  test("passes an allowlisted lockfile", () => {
    const result = checkStandaloneLockfiles({
      ...fixture({ "tools/legacy/yarn.lock": "", "tools/other/bun.lock": "" }),
      allowlist: [
        { path: "tools/legacy/yarn.lock", reason: "vendored fixture" },
        { path: "tools/other/bun.lock", reason: "vendored fixture" },
      ],
    });

    expect(result.errors).toEqual([]);
  });

  test("fails an allowlist entry that names no tracked file", () => {
    const result = checkStandaloneLockfiles({
      ...fixture({}),
      allowlist: [{ path: "tools/gone/yarn.lock", reason: "removed" }],
    });

    expect(result.errors).toEqual([
      "scripts/check-standalone-lockfiles.ts ALLOWLIST names tools/gone/yarn.lock, which is not a tracked file. Remove the entry.",
    ]);
  });

  test("ignores lockfiles under node_modules", () => {
    const result = checkStandaloneLockfiles(
      fixture({ "node_modules/pkg/yarn.lock": "" }),
    );

    expect(result.errors).toEqual([]);
  });
});

describe("install command parsing", () => {
  test.each([
    ["bun install --cwd tools/docs --frozen-lockfile", "tools/docs", true],
    ["bun --cwd=./tools/docs/ install", "tools/docs", false],
    ["cd tools/docs && bun ci", "tools/docs", true],
    ["bash scripts/retry.sh bun install --frozen-lockfile", "", true],
    ["bun i", "", false],
    ["(cd tools/docs && bun install)", "tools/docs", false],
    ["{ cd tools && bun install --cwd docs; }", "tools/docs", false],
    ['echo "$(bun --cwd tools/docs ci)"', "tools/docs", true],
  ])("%s", (line, dir, frozen) => {
    expect(parseInstallCommands(line, "fixture")).toEqual([
      { dir, frozen, source: "fixture" },
    ]);
  });

  test("ignores other bun subcommands", () => {
    expect(
      parseInstallCommands("bun --cwd tools/docs test && bun run build", "x"),
    ).toEqual([]);
  });
});
