import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import packageJson from "../apps/api/package.json" with { type: "json" };
import { avtPostgresTestFiles } from "../apps/api/scripts/avt-postgres-tests";
import { selectTestPaths } from "../apps/api/scripts/test-path-filters";
import { requiresAvtPostgres } from "./ci-avt-postgres";

const apiRoot = path.resolve(import.meta.dir, "../apps/api");
const runner = packageJson.ciGateTestRunners["test:postgres"];

const changedPaths = [
  "apps/api/src/lib/lists/verification/run-queue.ts",
  "apps/api/src/handlers/lists/verifications/create.ts",
  "apps/api/src/handlers/lists/items/sources/verification/update.ts",
  "apps/api/src/lib/views/avt-layout.db.test.ts",
  "apps/api/src/db/list-verification-rls.db.test.ts",
  "apps/api/drizzle/20260925220000_legal_list_verifications/migration.sql",
  "apps/web/src/features/avt/avt-view.tsx",
];

test("each admitted change runs every discovered verification Postgres suite", async () => {
  const discovered = await avtPostgresTestFiles();
  const cli = Bun.spawnSync({
    cmd: [
      process.execPath,
      "scripts/run-postgres-tests.ts",
      "--avt",
      "--list-files",
    ],
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: "postgres://selection-only" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(cli.exitCode, cli.stderr.toString()).toBe(0);
  const patterns = cli.stdout.toString().trim().split("\n");
  // Exercise the gated runner's discovery and positional filtering, without
  // executing DB suites or substituting a fake Bun command.
  const selected = selectTestPaths(discovered, patterns);
  expect(selected).not.toBeNull();
  for (const changed of changedPaths) {
    expect(requiresAvtPostgres([changed]), changed).toBe(true);
    expect(selected?.has("src/lib/views/avt-layout.db.test.ts"), changed).toBe(
      true,
    );
    expect(
      selected?.has("src/db/list-verification-rls.db.test.ts"),
      changed,
    ).toBe(true);
    for (const file of discovered) {
      expect(selected?.has(file), `${changed}: ${file}`).toBe(
        requiresAvtPostgres([`apps/api/${file}`]),
      );
    }
  }
  expect(selected?.has("src/db/transaction-abort.db.test.ts")).toBe(false);
  expect(requiresAvtPostgres(["docs/guide.md"])).toBe(false);
});

test("new nested suites in every verification path join selection automatically", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "avt-postgres-selection-"));
  const expected = [
    "src/lib/lists/verification/nested/new.db.test.ts",
    "src/handlers/lists/verifications/nested/new.db.test.ts",
    "src/handlers/lists/items/sources/verification/nested/new.db.test.ts",
    "src/lib/views/avt-layout-new.db.test.ts",
    "src/db/list-verification-new.db.test.ts",
  ].toSorted();
  try {
    for (const file of [...expected, "src/db/unrelated.db.test.ts"]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), `// ${runner.gate}\n`);
    }
    writeFileSync(
      path.join(root, "src/lib/views/avt-layout-unit.test.ts"),
      "// ungated\n",
    );
    writeFileSync(
      path.join(root, "src/lib/views/avt-layout-new.db.test.ts"),
      "// PGlite\n",
    );
    const discovered = [
      ...new Bun.Glob(runner.testFileGlob).scanSync({ cwd: root }),
    ];
    const selected = selectTestPaths(
      discovered,
      await avtPostgresTestFiles(root),
    );
    expect([...(selected ?? [])].toSorted()).toEqual(expected);
    for (const file of expected) {
      expect(requiresAvtPostgres([`apps/api/${file}`])).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("path planning runs from a checkout without installed workspace dependencies", () => {
  const root = mkdtempSync(path.join(tmpdir(), "avt-postgres-plan-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(
      path.join(import.meta.dir, "ci-avt-postgres.ts"),
      path.join(root, "scripts/ci-avt-postgres.ts"),
    );
    for (const changed of [...changedPaths, "docs/guide.md"]) {
      const cli = Bun.spawnSync({
        cmd: [process.execPath, "scripts/ci-avt-postgres.ts", changed],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(cli.exitCode, cli.stderr.toString()).toBe(0);
      expect(cli.stdout.toString().trim()).toBe(
        String(requiresAvtPostgres([changed])),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
