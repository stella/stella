import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixtures: string[] = [];
// Host git config (signed tags, hooks) must not change fixture repositories.
const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const table = (
  type = "text",
) => `import { pgTable, ${type} } from "drizzle-orm/pg-core";
export const items = pgTable("items", { value: ${type}("value") });
`;
const createFixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "migration-guard-"));
  fixtures.push(root);
  mkdirSync(path.join(root, "apps/api/src/db/schema"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/api/drizzle.config.ts"),
    'export default { schema: ["./src/db/schema/one.ts", "./src/db/schema/two.ts"] };\n',
  );
  writeFileSync(path.join(root, "apps/api/src/db/schema/one.ts"), table());
  writeFileSync(path.join(root, "apps/api/src/db/schema/two.ts"), "");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(
    path.join(root, "package.json"),
    '{"private":true,"workspaces":["packages/*"]}\n',
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      env: HERMETIC_GIT_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("add", ".");
  git("commit", "-m", "base");
  git("tag", "base");
  const sourceModules = path.resolve(import.meta.dir, "../node_modules");
  const fixtureModules = path.join(root, "node_modules");
  mkdirSync(fixtureModules);
  for (const entry of readdirSync(sourceModules)) {
    symlinkSync(
      path.join(sourceModules, entry),
      path.join(fixtureModules, entry),
    );
  }
  return { root, git };
};
const runGuard = (root: string, env = HERMETIC_GIT_ENV) =>
  Bun.spawnSync(
    ["bun", path.resolve(import.meta.dir, "check-migration-schema.ts"), "base"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a pure table move between schema files passes", () => {
  const { root, git } = createFixture();
  writeFileSync(path.join(root, "apps/api/src/db/schema/one.ts"), "");
  writeFileSync(path.join(root, "apps/api/src/db/schema/two.ts"), table());
  git("add", ".");
  git("commit", "-m", "move table");
  expect(runGuard(root).exitCode).toBe(0);
});

test("a table move with a changed column type fails", () => {
  const { root, git } = createFixture();
  writeFileSync(path.join(root, "apps/api/src/db/schema/one.ts"), "");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/two.ts"),
    table("integer"),
  );
  git("add", ".");
  git("commit", "-m", "move and change table");
  const result = runGuard(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    "ERROR: Database schema changed without a migration file in apps/api/drizzle/.",
  );
});

test("a column change with a migration folder passes", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    table("integer"),
  );
  mkdirSync(path.join(root, "apps/api/drizzle/20261030000000_change"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "apps/api/drizzle/20261030000000_change/migration.sql"),
    "ALTER TABLE items ALTER COLUMN value TYPE integer;\n",
  );
  git("add", ".");
  git("commit", "-m", "change table");
  expect(runGuard(root).exitCode).toBe(0);
});

test("an empty migration file does not count as providing one", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    table("integer"),
  );
  mkdirSync(path.join(root, "apps/api/drizzle/20261030000000_change"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "apps/api/drizzle/20261030000000_change/migration.sql"),
    "\n",
  );
  git("add", ".");
  git("commit", "-m", "change table");
  expect(runGuard(root).exitCode).toBe(1);
});

test("deleting an existing migration does not count as providing one", () => {
  const { root, git } = createFixture();
  mkdirSync(path.join(root, "apps/api/drizzle/20261029000000_existing"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "apps/api/drizzle/20261029000000_existing/migration.sql"),
    "CREATE TABLE items (value text);\n",
  );
  git("add", ".");
  git("commit", "-m", "existing migration");
  git("tag", "-f", "base");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    table("integer"),
  );
  rmSync(path.join(root, "apps/api/drizzle/20261029000000_existing"), {
    recursive: true,
    force: true,
  });
  git("add", "-A", ".");
  git("commit", "-m", "change table and drop a migration");
  expect(runGuard(root).exitCode).toBe(1);
});

test("a table in a configured non-public schema needs a migration", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/drizzle.config.ts"),
    'export default { schema: ["./src/db/schema/one.ts", "./src/db/schema/two.ts"], schemaFilter: ["public", "custom"] };\n',
  );
  git("add", ".");
  git("commit", "-m", "configure schemas");
  git("tag", "-f", "base");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/two.ts"),
    'import { pgSchema, text } from "drizzle-orm/pg-core";\nexport const custom = pgSchema("custom");\nexport const notes = custom.table("notes", { value: text("value") });\n',
  );
  git("add", ".");
  git("commit", "-m", "add custom schema table");
  expect(runGuard(root).exitCode).toBe(1);
});

test("a non-SQL file in a migration folder does not hide a schema change", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    table("integer"),
  );
  mkdirSync(path.join(root, "apps/api/drizzle/existing"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/api/drizzle/existing/README.md"),
    "note\n",
  );
  git("add", ".");
  git("commit", "-m", "change schema and migration note");
  expect(runGuard(root).exitCode).toBe(1);
});

test("a workspace helper change is resolved independently in each tree", () => {
  const { root, git } = createFixture();
  const packageRoot = path.join(root, "packages/schema-helper");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    '{"name":"@fixture/schema-helper","type":"module","exports":"./index.ts"}\n',
  );
  writeFileSync(
    path.join(packageRoot, "index.ts"),
    'import { text } from "drizzle-orm/pg-core";\nexport const column = () => text("value");\n',
  );
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    'import { pgTable } from "drizzle-orm/pg-core";\nimport { column } from "@fixture/schema-helper";\nexport const items = pgTable("items", { value: column() });\n',
  );
  mkdirSync(path.join(root, "node_modules/@fixture"), { recursive: true });
  symlinkSync(
    packageRoot,
    path.join(root, "node_modules/@fixture/schema-helper"),
  );
  git("add", ".");
  git("commit", "-m", "add schema helper");
  git("tag", "-f", "base");
  writeFileSync(
    path.join(packageRoot, "index.ts"),
    'import { integer } from "drizzle-orm/pg-core";\nexport const column = () => integer("value");\n',
  );
  git("add", ".");
  git("commit", "-m", "change schema helper");
  expect(runGuard(root).exitCode).toBe(1);
});

test("a failed worktree add preserves its error and removes the temporary directory", () => {
  const { root } = createFixture();
  const bin = path.join(root, "test-bin");
  mkdirSync(bin);
  const gitPath = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
  writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\nif [ "$1 $2" = "worktree add" ]; then echo "injected add failure" >&2; exit 23; fi\nexec "${gitPath}" "$@"\n`,
  );
  chmodSync(path.join(bin, "git"), 0o755);
  const before = new Set(
    readdirSync(tmpdir()).filter((entry) =>
      entry.startsWith("migration-schema-base-"),
    ),
  );
  const result = runGuard(root, {
    ...process.env,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("injected add failure");
  expect(
    readdirSync(tmpdir()).filter(
      (entry) =>
        entry.startsWith("migration-schema-base-") && !before.has(entry),
    ),
  ).toEqual([]);
});

test("an unrelated comment in a schema file passes", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    `// ownership note\n${table()}`,
  );
  git("add", ".");
  git("commit", "-m", "document schema");
  expect(runGuard(root).exitCode).toBe(0);
});

test("a schema change on an advanced base branch does not fail an unrelated branch", () => {
  const { root, git } = createFixture();
  git("switch", "-c", "feature");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    `// ownership note\n${table()}`,
  );
  git("add", ".");
  git("commit", "-m", "document schema");
  git("switch", "main");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    table("integer"),
  );
  mkdirSync(path.join(root, "apps/api/drizzle/20261030000000_change"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "apps/api/drizzle/20261030000000_change/migration.sql"),
    "ALTER TABLE items ALTER COLUMN value TYPE integer;\n",
  );
  git("add", ".");
  git("commit", "-m", "change table on main");
  git("tag", "-f", "base", "main");
  git("switch", "feature");
  expect(runGuard(root).exitCode).toBe(0);
});

const tables = (...names: string[]) =>
  `import { pgTable, text } from "drizzle-orm/pg-core";\n${names
    .map(
      (name) =>
        `export const ${name} = pgTable("${name}", { value: text("value") });\n`,
    )
    .join("")}`;

test("a table move that reorders several tables passes", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    tables("alpha", "beta"),
  );
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/two.ts"),
    tables("gamma"),
  );
  git("add", ".");
  git("commit", "-m", "several tables");
  git("tag", "-f", "base");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/one.ts"),
    tables("beta"),
  );
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/two.ts"),
    tables("gamma", "alpha"),
  );
  git("add", ".");
  git("commit", "-m", "move alpha");
  expect(runGuard(root).exitCode).toBe(0);
});

test("a column type change among several tables fails", () => {
  const { root, git } = createFixture();
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/two.ts"),
    tables("alpha", "beta"),
  );
  git("add", ".");
  git("commit", "-m", "several tables");
  git("tag", "-f", "base");
  writeFileSync(
    path.join(root, "apps/api/src/db/schema/two.ts"),
    tables("beta").replace(
      'import { pgTable, text } from "drizzle-orm/pg-core";\n',
      'import { integer, pgTable, text } from "drizzle-orm/pg-core";\nexport const alpha = pgTable("alpha", { value: integer("value") });\n',
    ),
  );
  git("add", ".");
  git("commit", "-m", "change alpha");
  expect(runGuard(root).exitCode).toBe(1);
});
