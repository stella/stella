import { Result, TaggedError } from "better-result";
import { SQL, type ReservedSQL } from "bun";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { sha256Hex } from "@stll/sha256/bun";
import { DAY_IN_MS } from "@stll/time";

import {
  resolveDockerTarget,
  resolveInstalledDevDockerKeeper,
} from "./dev-docker";
import { withSharedPostgresLock } from "./dev-postgres-lock";

class SharedTestPostgresError extends TaggedError("SharedTestPostgresError")<{
  message: string;
  cause?: unknown;
}> {}

const CONTAINER = "stella-shared-test-postgres";
const IMAGE = "stella-shared-test-postgres:18";
const PORT = 15_432;
const OWNER = "stella_test_owner";
const SHARED_TEST_TEMPLATE_TTL_MS = DAY_IN_MS;
const TEMPLATE_GC_BATCH_SIZE = 100;
const TEMPLATE_STATUS = { building: "building", ready: "ready" } as const;
const sharedTestTemplateName = (key: string) =>
  `stella_test_tpl_${key.slice(0, 40)}`;

export const sharedTestDatabase = (tree: string) =>
  `stella_test_${sha256Hex(tree).slice(0, 24)}`;

export const sharedTestMigrationHistory = (tree: string) => {
  const folder = path.join(tree, "apps/api/drizzle");
  const entries = readdirSync(folder, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(folder, entry.name, "migration.sql")),
    )
    .map(({ name }) => ({
      name,
      content: sha256Hex(
        readFileSync(path.join(folder, name, "migration.sql")),
      ),
    }))
    .toSorted(({ name: left }, { name: right }) => left.localeCompare(right));
  return { folder, key: sha256Hex(JSON.stringify(entries)) };
};

export const snapshotSharedTestMigrations = (
  history: ReturnType<typeof sharedTestMigrationHistory>,
  histories: string,
) => {
  mkdirSync(histories, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(path.join(histories, ".building-"));
  const snapshot = path.join(histories, history.key);
  try {
    const folder = path.join(temporary, "apps/api/drizzle");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(history.folder, { withFileTypes: true })) {
      const file = path.join(history.folder, entry.name, "migration.sql");
      if (!entry.isDirectory() || !existsSync(file)) {
        continue;
      }
      const destination = path.join(folder, entry.name);
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(destination, "migration.sql"),
        readFileSync(file),
        {
          mode: 0o600,
        },
      );
    }
    if (sharedTestMigrationHistory(temporary).key !== history.key) {
      throw new SharedTestPostgresError({
        message:
          "Worker migrations changed during snapshot; retry preparation.",
      });
    }
    // Only incomplete templates reach this path, under the cluster advisory lock.
    rmSync(snapshot, { recursive: true, force: true });
    renameSync(temporary, snapshot);
    return path.join(snapshot, "apps/api/drizzle");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

const secret = (directory: string, name: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!statSync(directory).mode.toString(8).endsWith("00")) {
    throw new SharedTestPostgresError({
      message: "Shared Postgres state directory must be private.",
    });
  }
  const file = path.join(directory, name);
  const created = Result.try(() =>
    writeFileSync(file, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    }),
  );
  if (created.isErr() && !existsSync(file)) {
    throw new SharedTestPostgresError({
      message: "Cannot create shared Postgres credential.",
    });
  }
  if (
    !lstatSync(file).isFile() ||
    !statSync(file).mode.toString(8).endsWith("00")
  ) {
    throw new SharedTestPostgresError({
      message: "Shared Postgres credentials must be private regular files.",
    });
  }
  const value = readFileSync(file, "utf-8");
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new SharedTestPostgresError({
      message: "Invalid shared Postgres credential file.",
    });
  }
  return value;
};

type DockerCommand = (args: string[], input?: string) => string;

type EnsureContainerOptions = {
  docker: DockerCommand;
  state: string;
  password: string;
  repo: string;
  action: "prepare" | "drop" | "gc";
};

const ensureContainer = async ({
  docker,
  state,
  password,
  repo,
  action,
}: EnsureContainerOptions) => {
  const exists = docker([
    "ps",
    "-a",
    "--filter",
    `name=^/${CONTAINER}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (!exists && action !== "prepare") {
    return "absent";
  }
  if (!exists) {
    docker(["build", "-t", IMAGE, "-f", "docker/postgres/Dockerfile", repo]);
    const envFile = path.join(state, "container.env");
    writeFileSync(
      envFile,
      `POSTGRES_USER=${OWNER}\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${password}\n`,
      { mode: 0o600 },
    );
    const started = Result.try(() =>
      docker([
        "run",
        "-d",
        "--name",
        CONTAINER,
        "--label",
        "dev.stella.shared-test-postgres=true",
        "--memory",
        "512m",
        "--publish",
        `127.0.0.1:${PORT}:5432`,
        "--env-file",
        envFile,
        "--mount",
        "type=volume,source=stella-shared-test-postgres-data,target=/var/lib/postgresql",
        IMAGE,
        "postgres",
        "-c",
        "config_file=/etc/postgresql/server.conf",
        "-c",
        "shared_buffers=64MB",
        "-c",
        "max_connections=100",
      ]),
    );
    if (
      started.isErr() &&
      !docker([
        "ps",
        "-a",
        "--filter",
        `name=^/${CONTAINER}$`,
        "--format",
        "{{.Names}}",
      ])
    ) {
      throw started.error;
    }
  }
  if (
    docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "dev.stella.shared-test-postgres"}}',
      CONTAINER,
    ]) !== "true"
  ) {
    throw new SharedTestPostgresError({
      message: "Container name is occupied by an unowned Postgres instance.",
    });
  }
  docker(["start", CONTAINER]);
  for (let attempt = 0; ; attempt++) {
    const ready = Result.try(() =>
      docker([
        "exec",
        CONTAINER,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        OWNER,
        "-d",
        "postgres",
      ]),
    );
    if (ready.isOk()) {
      break;
    }
    if (attempt === 59) {
      throw new SharedTestPostgresError({
        message: "Shared Postgres did not become ready.",
      });
    }
    await Bun.sleep(1000);
  }
  docker(
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      OWNER,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    "SELECT 1;\n",
  );
  return "ready";
};

const initializeTemplateRegistry = async (session: ReservedSQL) => {
  await session.unsafe(`CREATE SCHEMA IF NOT EXISTS stella_shared_test;
    CREATE TABLE IF NOT EXISTS stella_shared_test.templates (
      history_key text PRIMARY KEY,
      template_name text UNIQUE NOT NULL,
      status text NOT NULL CHECK (status IN ('${TEMPLATE_STATUS.building}', '${TEMPLATE_STATUS.ready}')),
      unused_since timestamptz
    );
    CREATE TABLE IF NOT EXISTS stella_shared_test.worktrees (
      database_name text PRIMARY KEY,
      tree_path text NOT NULL,
      history_key text NOT NULL REFERENCES stella_shared_test.templates(history_key)
    );
    CREATE INDEX IF NOT EXISTS shared_test_worktree_history ON stella_shared_test.worktrees (history_key);
    CREATE INDEX IF NOT EXISTS shared_test_template_idle ON stella_shared_test.templates (unused_since, history_key);`);
};

const collectUnusedTemplates = async (session: ReservedSQL, state: string) => {
  let after = "";
  for (;;) {
    const workers =
      await session`SELECT database_name, tree_path FROM stella_shared_test.worktrees
      WHERE database_name > ${after} ORDER BY database_name LIMIT ${TEMPLATE_GC_BATCH_SIZE}`;
    if (workers.length === 0) {
      break;
    }
    for (const worker of workers) {
      const tree = worker["tree_path"];
      const database = worker["database_name"];
      if (
        typeof tree !== "string" ||
        typeof database !== "string" ||
        database !== sharedTestDatabase(tree)
      ) {
        throw new SharedTestPostgresError({
          message: "Invalid shared worktree registry identity.",
        });
      }
      after = database;
      const present = Result.try({
        try: () => statSync(tree),
        catch: (cause) =>
          new SharedTestPostgresError({
            message: "Cannot inspect registered worktree for cleanup.",
            cause,
          }),
      });
      if (present.isOk()) {
        continue;
      }
      const cause = present.error.cause;
      if (
        typeof cause !== "object" ||
        cause === null ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      ) {
        throw present.error;
      }
      await session.unsafe(
        `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
      );
      await session`DELETE FROM stella_shared_test.worktrees WHERE database_name = ${database}`;
      rmSync(path.join(state, `${database}.url`), { force: true });
    }
  }
  await session`UPDATE stella_shared_test.templates t SET unused_since =
    CASE WHEN EXISTS (SELECT 1 FROM stella_shared_test.worktrees w WHERE w.history_key = t.history_key)
      THEN NULL ELSE coalesce(t.unused_since, now()) END`;
  const expired =
    await session`SELECT history_key, template_name FROM stella_shared_test.templates
    WHERE unused_since <= now() - ${SHARED_TEST_TEMPLATE_TTL_MS} * interval '1 millisecond'
    ORDER BY unused_since, history_key LIMIT ${TEMPLATE_GC_BATCH_SIZE}`;
  for (const row of expired) {
    const key = row["history_key"];
    const template = row["template_name"];
    if (
      typeof key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(key) ||
      template !== sharedTestTemplateName(key)
    ) {
      throw new SharedTestPostgresError({
        message: "Invalid shared template registry identity.",
      });
    }
    await session.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    await session`DELETE FROM stella_shared_test.templates WHERE history_key = ${key}`;
    rmSync(path.join(state, "histories", key), {
      recursive: true,
      force: true,
    });
  }
};

type EnsureWorkerTemplateOptions = {
  session: ReservedSQL;
  docker: DockerCommand;
  state: string;
  tree: string;
  repo: string;
  password: string;
};

const ensureWorkerTemplate = async ({
  session,
  docker,
  state,
  tree,
  repo,
  password,
}: EnsureWorkerTemplateOptions) => {
  const history = sharedTestMigrationHistory(tree);
  const template = sharedTestTemplateName(history.key);
  const existing =
    await session`SELECT status FROM stella_shared_test.templates WHERE history_key = ${history.key}`;
  if (existing.at(0)?.["status"] === TEMPLATE_STATUS.ready) {
    return { key: history.key, template };
  }
  await session`INSERT INTO stella_shared_test.templates (history_key, template_name, status)
    VALUES (${history.key}, ${template}, ${TEMPLATE_STATUS.building}) ON CONFLICT (history_key) DO NOTHING`;
  // Retry only an incomplete template, which has never been handed to a worker.
  await session.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
  await session.unsafe(`CREATE DATABASE "${template}" OWNER "${OWNER}"`);
  const folder = snapshotSharedTestMigrations(
    history,
    path.join(state, "histories"),
  );
  docker(
    [
      "exec",
      "-i",
      "--user",
      "postgres",
      CONTAINER,
      "psql",
      "-U",
      "stella_maintenance",
      "-d",
      template,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `owner=${OWNER}`,
    ],
    `SET ROLE stella_bootstrap;\n${readFileSync(path.join(repo, "docker/postgres/init.sql"), "utf-8")}`,
  );
  const migrated = Bun.spawnSync(
    ["bun", "run", "scripts/migrate-shared-test-template.ts", folder],
    {
      cwd: path.join(repo, "apps/api"),
      env: {
        ...process.env,
        DATABASE_URL: `postgres://${OWNER}:${password}@127.0.0.1:${PORT}/${template}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!migrated.success) {
    throw new SharedTestPostgresError({
      message: `Worker template migration failed (exit ${migrated.exitCode}); credential-bearing output withheld.`,
    });
  }
  await session`UPDATE stella_shared_test.templates SET status = ${TEMPLATE_STATUS.ready} WHERE history_key = ${history.key}`;
  return { key: history.key, template };
};

const migrateWorkerOnline = (tree: string, url: string) => {
  if (
    !existsSync(path.join(tree, "apps/api/node_modules/better-result")) ||
    !existsSync(path.join(tree, "apps/api/src/db/migrate.ts"))
  ) {
    return;
  }
  const migrated = Bun.spawnSync(["bun", "run", "src/db/migrate.ts"], {
    cwd: path.join(tree, "apps/api"),
    env: {
      ...process.env,
      DATABASE_URL: url,
      DB_LOAD_GATE_EBS_SIGNAL: "disabled",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!migrated.success) {
    throw new SharedTestPostgresError({
      message: `Worker revision online migration failed (exit ${migrated.exitCode}); credential-bearing output withheld.`,
    });
  }
};

const run = async () => {
  const [action, flag, tree] = process.argv.slice(2);
  if (
    (action !== "prepare" && action !== "drop" && action !== "gc") ||
    (action !== "gc" && (flag !== "--tree" || !tree))
  ) {
    throw new SharedTestPostgresError({
      message: "Usage: shared-test-postgres.sh prepare|drop --tree PATH, or gc",
    });
  }
  const workerTree = tree ? realpathSync(tree) : "";
  const database = sharedTestDatabase(workerTree);
  const state = path.join(
    homedir(),
    ".local/state/stella/shared-test-postgres",
  );
  const password = secret(state, "owner.password");
  const repo = path.resolve(import.meta.dir, "../../..");
  using target = resolveDockerTarget({ env: process.env }).unwrap();
  resolveInstalledDevDockerKeeper(target).unwrap();
  const docker = (args: string[], input?: string) => {
    const result = Bun.spawnSync(["docker", "--host", target.host, ...args], {
      env: target.env,
      stdin: input ? Buffer.from(input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!result.success) {
      // Docker output may contain credentials; keep the boundary error redacted.
      throw new SharedTestPostgresError({
        message: `Shared Postgres Docker ${args.at(0)} failed (exit ${result.exitCode}).`,
      });
    }
    return result.stdout.toString().trim();
  };
  if (
    (await ensureContainer({ docker, state, password, repo, action })) ===
    "absent"
  ) {
    return;
  }
  const admin = new SQL({
    url: `postgres://${OWNER}:${password}@127.0.0.1:${PORT}/postgres`,
    max: 1,
  });
  const session = await admin.reserve();
  try {
    await withSharedPostgresLock(session, async () => {
      await initializeTemplateRegistry(session);
      if (action === "gc") {
        await collectUnusedTemplates(session, state);
        return;
      }
      if (action === "drop") {
        await session.unsafe(
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        );
        rmSync(path.join(state, `${database}.url`), { force: true });
        await session`DELETE FROM stella_shared_test.worktrees WHERE database_name = ${database}`;
        await collectUnusedTemplates(session, state);
        return;
      }
      const { key, template } = await ensureWorkerTemplate({
        session,
        docker,
        state,
        tree: workerTree,
        repo,
        password,
      });
      const registered =
        await session`SELECT history_key FROM stella_shared_test.worktrees WHERE database_name = ${database}`;
      if (registered.length && registered.at(0)?.["history_key"] !== key) {
        throw new SharedTestPostgresError({
          message:
            "Worker migration history changed; drop its test database before preparing again.",
        });
      }
      const databases =
        await session`SELECT datname FROM pg_database WHERE datname = ${database}`;
      if (databases.length !== 0 && registered.length === 0) {
        throw new SharedTestPostgresError({
          message:
            "Unregistered worker database exists; drop it before preparing again.",
        });
      }
      if (databases.length === 0) {
        await session.unsafe(
          `CREATE DATABASE "${database}" TEMPLATE "${template}" OWNER "${OWNER}"`,
        );
      }
      const url = `postgres://${OWNER}:${password}@127.0.0.1:${PORT}/${database}`;
      const posture =
        await session`SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datdba = r.oid WHERE r.rolname = ${OWNER} AND d.datname = ${database} AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.rolcreatedb AND r.rolcreaterole`;
      if (posture.length !== 1) {
        throw new SharedTestPostgresError({
          message:
            "Shared test database owner has an invalid privilege posture.",
        });
      }
      await session`INSERT INTO stella_shared_test.worktrees (database_name, tree_path, history_key)
        VALUES (${database}, ${workerTree}, ${key})
        ON CONFLICT (database_name) DO UPDATE SET tree_path = EXCLUDED.tree_path`;
      if (sharedTestMigrationHistory(workerTree).key !== key) {
        throw new SharedTestPostgresError({
          message:
            "Worker migrations changed during preparation; drop and prepare its test database again.",
        });
      }
      migrateWorkerOnline(workerTree, url);
      const urlFile = path.join(state, `${database}.url`);
      const temporary = path.join(
        state,
        `.url-write-${randomBytes(16).toString("hex")}`,
      );
      writeFileSync(temporary, url, { flag: "wx", mode: 0o600 });
      renameSync(temporary, urlFile);
      await collectUnusedTemplates(session, state);
      process.stdout.write(
        `${JSON.stringify({ database, urlFile, template })}\n`,
      );
    });
  } finally {
    session.release();
    await admin.close();
  }
};

if (import.meta.main) {
  const result = await Result.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof SharedTestPostgresError
        ? cause
        : new SharedTestPostgresError({
            message:
              "Shared test Postgres provisioning failed; inspect the host Docker service and private state.",
          }),
  });
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  }
}
