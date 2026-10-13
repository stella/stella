import { Result, TaggedError } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";

import {
  ensureContainer,
  sharedTestDatabase,
  sharedTestMigrationHistory,
  snapshotSharedTestMigrations,
} from "./shared-test-postgres";

class FixtureDockerError extends TaggedError("SharedTestPostgresError")<{
  message: string;
}> {}

test("container startup removes its private credential file on success and failure", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const state = mkdtempSync(path.join(tmpdir(), "stella-pg-container-"));
    let envFile = "";
    let runCalls = 0;
    const docker = (args: string[]) => {
      if (args.at(0) === "build") {
        expect(path.isAbsolute(args.at(args.indexOf("-f") + 1) ?? "")).toBe(
          true,
        );
      }
      if (args.at(0) === "run") {
        runCalls++;
        envFile = args.at(args.indexOf("--env-file") + 1) ?? "";
        expect(readFileSync(envFile, "utf-8")).toContain(
          "POSTGRES_PASSWORD=fixture",
        );
        expect(statSync(envFile).mode.toString(8).slice(-3)).toBe("600");
        return outcome === "success"
          ? Result.ok("started")
          : Result.err(
              new FixtureDockerError({ message: "Docker startup failed" }),
            );
      }
      return Result.ok(args.at(0) === "inspect" ? "true" : "");
    };
    try {
      const result = await ensureContainer({
        docker,
        state,
        password: "fixture",
        repo: state,
        action: "prepare",
      });
      expect(runCalls).toBe(1);
      expect(result.isOk()).toBe(outcome === "success");
      expect(existsSync(envFile)).toBe(false);
      expect(readdirSync(state)).toEqual([]);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  }
});

test("worktree identities are bounded SQL identifiers and distinguish paths", () => {
  const paths = [
    "/work/a",
    "/work/b",
    "/work/á",
    "/work/a b",
    '/work/team\'s notes; "draft"',
  ];
  const databases = paths.map(sharedTestDatabase);
  expect(new Set(databases).size).toBe(paths.length);
  for (const database of databases) {
    expect(database).toMatch(/^stella_test_[a-f0-9]{24}$/u);
    expect(database.length).toBeLessThan(63);
  }
  expect(sharedTestDatabase("/work/a")).toBe(sharedTestDatabase("/work/a"));
});

test("concurrent first-use credential preparation publishes one complete private credential", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-pg-credential-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const directory = path.join(root, "fresh-state");
    const script = path.join(root, "prepare.ts");
    writeFileSync(
      script,
      `
      import { sharedTestCredential } from ${JSON.stringify(path.join(import.meta.dir, "shared-test-postgres.ts"))};
      import { createHash } from "node:crypto";
      await Bun.stdin.text();
      const value = sharedTestCredential(${JSON.stringify(directory)}, "owner.password").unwrap();
      console.log(createHash("sha256").update(value).digest("hex"));
    `,
    );
    const processes = Array.from({ length: 4 }, () => {
      const child = Bun.spawn([process.execPath, script], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      return child;
    });
    for (const child of processes) {
      child.stdin.end();
    }
    const results = await Promise.all(
      processes.map(async (child) => ({
        code: await child.exited,
        output: await new Response(child.stdout).text(),
        error: await new Response(child.stderr).text(),
      })),
    );
    const credential = path.join(directory, "owner.password");
    const value = readFileSync(credential, "utf-8");
    expect(value).toMatch(/^[a-f0-9]{64}$/u);
    for (const result of results) {
      expect(result.error).toBe("");
      expect(result.code).toBe(0);
      expect(result.output.trim()).toBe(sha256Hex(value));
    }
    expect(readdirSync(directory)).toEqual(["owner.password"]);
    expect(statSync(credential).mode.toString(8).slice(-3)).toBe("600");
  } finally {
    for (const child of children) {
      child.kill();
    }
    await Promise.all(children.map(async (child) => child.exited));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected migration snapshot can be retried after an added migration is reverted", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-pg-snapshot-"));
  try {
    const tree = path.join(root, "worker");
    const first = path.join(tree, "apps/api/drizzle/20260101000000_first");
    mkdirSync(first, { recursive: true });
    writeFileSync(path.join(first, "migration.sql"), "SELECT 1;");
    const history = sharedTestMigrationHistory(tree);
    const histories = path.join(root, "histories");
    const extra = path.join(tree, "apps/api/drizzle/20260102000000_extra");
    mkdirSync(extra);
    writeFileSync(path.join(extra, "migration.sql"), "SELECT 2;");
    const rejected = snapshotSharedTestMigrations(history, histories);
    expect(rejected.isErr()).toBe(true);
    if (rejected.isErr()) {
      expect(rejected.error.message).toContain(
        "Worker migrations changed during snapshot",
      );
    }
    expect(existsSync(path.join(histories, history.key))).toBe(false);
    expect(readdirSync(histories)).toEqual([]);
    rmSync(extra, { recursive: true });
    expect(sharedTestMigrationHistory(tree).key).toBe(history.key);
    const folder = snapshotSharedTestMigrations(history, histories).unwrap();
    expect(readdirSync(folder)).toEqual(["20260101000000_first"]);
    expect(
      sharedTestMigrationHistory(path.join(histories, history.key)).key,
    ).toBe(history.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration history identity follows ordered migration names and SQL rather than worker paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-pg-history-"));
  const trees = [path.join(root, "a"), path.join(root, "b")] as const;
  const migrations = [
    ["20260101000000_first", "CREATE TABLE first_fixture (id integer);"],
    ["20260102000000_second", "CREATE TABLE second_fixture (id integer);"],
  ] as const;
  try {
    for (const [index, tree] of trees.entries()) {
      const ordered = index === 0 ? migrations : migrations.toReversed();
      for (const [name, sql] of ordered) {
        const folder = path.join(tree, "apps/api/drizzle", name);
        mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, "migration.sql"), sql);
      }
    }
    const [first, second] = trees;
    const baseline = sharedTestMigrationHistory(first);
    expect(baseline.folder).toBe(path.join(first, "apps/api/drizzle"));
    expect(sharedTestMigrationHistory(second).key).toBe(baseline.key);
    const changedSql = path.join(
      second,
      "apps/api/drizzle",
      migrations[1][0],
      "migration.sql",
    );
    writeFileSync(
      changedSql,
      `${migrations[1][1]}\n-- changed committed migration`,
    );
    expect(sharedTestMigrationHistory(second).key).not.toBe(baseline.key);
    writeFileSync(changedSql, migrations[1][1]);
    expect(sharedTestMigrationHistory(second).key).toBe(baseline.key);
    renameSync(
      path.dirname(changedSql),
      path.join(second, "apps/api/drizzle/20260103000000_renamed"),
    );
    expect(sharedTestMigrationHistory(second).key).not.toBe(baseline.key);
    const appended = path.join(
      first,
      "apps/api/drizzle/20260104000000_appended",
    );
    mkdirSync(appended);
    writeFileSync(
      path.join(appended, "migration.sql"),
      "CREATE TABLE appended_fixture (id integer);",
    );
    expect(sharedTestMigrationHistory(first).key).not.toBe(baseline.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
