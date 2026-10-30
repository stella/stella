import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixtures: string[] = [];
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
  symlinkSync(
    path.resolve(import.meta.dir, "../node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("add", ".");
  git("commit", "-m", "base");
  git("tag", "base");
  return { root, git };
};
const runGuard = (root: string) =>
  Bun.spawnSync(
    ["bun", path.resolve(import.meta.dir, "check-migration-schema.ts"), "base"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
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
