import { Result } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";

import {
  DOCKER_FAILURE_KIND,
  ensureContainer,
  readDockerResult,
  SharedPostgresDockerError,
  sharedTestCredential,
  sharedTestDatabase,
  sharedTestMigrationHistory,
  snapshotSharedTestMigrations,
} from "./shared-test-postgres";

test("container startup removes its private credential file on success and failure", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const state = mkdtempSync(path.join(tmpdir(), "stella-pg-container-"));
    let envFile = "";
    let runCalls = 0;
    let listings = 0;
    const docker = (args: readonly string[]) => {
      if (args.at(0) === "ps") {
        listings++;
      }
      if (args.at(0) === "build") {
        expect(path.isAbsolute(args.at(args.indexOf("-f") + 1) ?? "")).toBe(
          true,
        );
      }
      return Result.ok(args.at(0) === "inspect" ? "true" : "");
    };
    const startContainer = (file: string) => {
      runCalls++;
      envFile = file;
      expect(readFileSync(envFile, "utf-8")).toContain(
        "POSTGRES_PASSWORD=fixture",
      );
      expect(statSync(envFile).mode.toString(8).slice(-3)).toBe("600");
      return outcome === "success"
        ? Result.ok("started")
        : Result.err(
            new SharedPostgresDockerError({
              kind: DOCKER_FAILURE_KIND.commandFailed,
              message: "Docker startup failed",
            }),
          );
    };
    try {
      const result = await ensureContainer({
        docker,
        startContainer,
        state,
        password: "fixture",
        repo: state,
        action: "prepare",
      });
      expect(runCalls).toBe(1);
      expect(listings).toBe(1);
      expect(result.isOk()).toBe(outcome === "success");
      expect(existsSync(envFile)).toBe(false);
      expect(readdirSync(state)).toEqual(["container.lock"]);
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

test("a name-conflict loser waits until Docker publishes the winning container", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "stella-pg-publication-"));
  let listings = 0;
  const docker = (args: readonly string[]) => {
    if (args.at(0) === "ps") {
      listings++;
      return Result.ok(listings < 3 ? "" : "stella-shared-test-postgres");
    }
    return Result.ok(args.at(0) === "inspect" ? "true" : "");
  };
  const startContainer = () =>
    Result.err(
      new SharedPostgresDockerError({
        kind: DOCKER_FAILURE_KIND.nameConflict,
        message: "Docker has reserved the container name",
      }),
    );
  try {
    const result = await ensureContainer({
      docker,
      startContainer,
      state,
      password: "fixture",
      repo: state,
      action: "prepare",
    });
    expect(result.unwrap()).toBe("ready");
    expect(listings).toBe(3);
    expect(readdirSync(state)).toEqual(["container.lock"]);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("concurrent cold provisioning callers create exactly one container", async () => {
  const state = mkdtempSync(
    path.join(tmpdir(), "stella-pg-concurrent-container-"),
  );
  let runs = 0;
  let published = false;
  let publish: ReturnType<typeof setTimeout> | undefined;
  const docker = (args: readonly string[]) => {
    if (args.at(0) === "ps") {
      return Result.ok(published ? "stella-shared-test-postgres" : "");
    }
    return Result.ok(args.at(0) === "inspect" ? "true" : "");
  };
  const startContainer = () => {
    runs++;
    if (runs === 1) {
      publish = setTimeout(() => {
        published = true;
      }, 20);
    }
    return Result.ok("started");
  };
  try {
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        async () =>
          await ensureContainer({
            docker,
            startContainer,
            state,
            password: "fixture",
            repo: state,
            action: "prepare",
          }),
      ),
    );
    expect(
      results.map((result: Awaited<ReturnType<typeof ensureContainer>>) =>
        result.unwrap(),
      ),
    ).toEqual(Array.from({ length: 8 }, () => "ready"));
    expect(runs).toBe(1);
    expect(readdirSync(state)).toEqual(["container.lock"]);
  } finally {
    clearTimeout(publish);
    rmSync(state, { recursive: true, force: true });
  }
});

test("Docker diagnostics retain the failure reason while masking passwords and env-file payloads", () => {
  const password = "a".repeat(64);
  const environment = `POSTGRES_USER=fixture\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${password}\n`;
  const reasons = [
    'Conflict. The container name "/stella-shared-test-postgres" is already in use by container "fixture".',
    "listen tcp: address already in use",
    "unknown flag: --fixture",
  ];
  for (const reason of reasons) {
    const result = readDockerResult({
      result: {
        success: false,
        exitCode: 125,
        stdout: Buffer.from(""),
        stderr: Buffer.from(
          `${reason}\n${environment}\n${JSON.stringify(environment)}\n${password}`,
        ),
      },
      action: "run",
      secretValues: [password, environment, JSON.stringify(environment)],
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain(reason);
      expect(result.error.message).not.toContain(password);
      expect(result.error.message).not.toContain("POSTGRES_USER");
      expect(result.error.message).toContain("[redacted]");
      expect(result.error.kind).toBe(
        reason.startsWith("Conflict.")
          ? DOCKER_FAILURE_KIND.nameConflict
          : DOCKER_FAILURE_KIND.commandFailed,
      );
    }
  }
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
      await child.stdin.end();
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
    expect(sharedTestCredential(directory, "owner.password").unwrap()).toBe(
      value,
    );
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
