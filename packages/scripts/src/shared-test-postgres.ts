import { panic, Result, TaggedError } from "better-result";
import { type ReservedSQL, SQL } from "bun";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import { withGenerationLock } from "./generation-lock";

class SharedTestPostgresError extends TaggedError("SharedTestPostgresError")<{
  message: string;
  cause?: unknown;
}> {}

export const DOCKER_FAILURE_KIND = {
  nameConflict: "name_conflict",
  commandFailed: "command_failed",
} as const;

export class SharedPostgresDockerError extends TaggedError(
  "SharedPostgresDockerError",
)<{
  message: string;
  kind: (typeof DOCKER_FAILURE_KIND)[keyof typeof DOCKER_FAILURE_KIND];
}> {}

const CONTAINER_CREATION_LOCK_TIMEOUT_MS = 5 * 60_000;
const CONTAINER_PUBLICATION_ATTEMPTS = 60;
const CONTAINER_PUBLICATION_RETRY_MS = 100;

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
      return Result.err(
        new SharedTestPostgresError({
          message:
            "Worker migrations changed during snapshot; retry preparation.",
        }),
      );
    }
    // Only incomplete templates reach this path, under the cluster advisory lock.
    rmSync(snapshot, { recursive: true, force: true });
    renameSync(temporary, snapshot);
    return Result.ok(path.join(snapshot, "apps/api/drizzle"));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

export const sharedTestCredential = (directory: string, name: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!statSync(directory).mode.toString(8).endsWith("00")) {
    return Result.err(
      new SharedTestPostgresError({
        message: "Shared Postgres state directory must be private.",
      }),
    );
  }
  const file = path.join(directory, name);
  const temporary = mkdtempSync(path.join(directory, ".credential-"));
  try {
    const candidate = path.join(temporary, "value");
    writeFileSync(candidate, randomBytes(32).toString("hex"), { mode: 0o600 });
    // A hard link publishes complete contents without replacing another caller's winner.
    const published = Result.try(() => linkSync(candidate, file));
    if (
      published.isErr() &&
      !(
        published.error.cause instanceof Error &&
        "code" in published.error.cause &&
        published.error.cause.code === "EEXIST"
      )
    ) {
      return Result.err(
        new SharedTestPostgresError({
          message: "Cannot create shared Postgres credential.",
          cause: published.error,
        }),
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (
    !lstatSync(file).isFile() ||
    !statSync(file).mode.toString(8).endsWith("00")
  ) {
    return Result.err(
      new SharedTestPostgresError({
        message: "Shared Postgres credentials must be private regular files.",
      }),
    );
  }
  const value = readFileSync(file, "utf-8");
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    return Result.err(
      new SharedTestPostgresError({
        message: "Invalid shared Postgres credential file.",
      }),
    );
  }
  return Result.ok(value);
};

type DockerArguments =
  | readonly ["ps", ...string[]]
  | readonly ["build", ...string[]]
  | readonly ["inspect", ...string[]]
  | readonly ["start", ...string[]]
  | readonly ["exec", ...string[]];

type DockerCommand = (
  args: DockerArguments,
  input?: string,
) => Result<string, SharedPostgresDockerError>;

type EnsureContainerOptions = {
  docker: DockerCommand;
  startContainer: (
    envFile: string,
  ) => Result<string, SharedPostgresDockerError>;
  state: string;
  password: string;
  repo: string;
  action: "prepare" | "drop" | "gc";
};

const ensureContainerUnlocked = async ({
  docker,
  startContainer,
  state,
  password,
  repo,
  action,
}: EnsureContainerOptions) => {
  const existing = docker([
    "ps",
    "-a",
    "--filter",
    `name=^/${CONTAINER}$`,
    "--format",
    "{{.Names}}",
  ]);
  if (existing.isErr()) {
    return existing;
  }
  const exists = existing.value;
  if (!exists && action !== "prepare") {
    return Result.ok("absent" as const);
  }
  if (!exists) {
    const built = docker([
      "build",
      "-t",
      IMAGE,
      "-f",
      path.join(repo, "docker/postgres/Dockerfile"),
      repo,
    ]);
    if (built.isErr()) {
      return built;
    }
    const envDirectory = mkdtempSync(path.join(state, ".container-"));
    const envFile = path.join(envDirectory, "container.env");
    try {
      writeFileSync(
        envFile,
        `POSTGRES_USER=${OWNER}\nPOSTGRES_DB=postgres\nPOSTGRES_PASSWORD=${password}\n`,
        { flag: "wx", mode: 0o600 },
      );
      const started = startContainer(envFile);
      if (started.isErr()) {
        switch (started.error.kind) {
          case DOCKER_FAILURE_KIND.commandFailed:
            return started;
          case DOCKER_FAILURE_KIND.nameConflict:
            // Docker reserves the name before it publishes the container in its list.
            for (let attempt = 0; ; attempt++) {
              const winner = docker([
                "ps",
                "-a",
                "--filter",
                `name=^/${CONTAINER}$`,
                "--format",
                "{{.Names}}",
              ]);
              if (winner.isErr()) {
                return winner;
              }
              if (winner.value) {
                break;
              }
              if (attempt === CONTAINER_PUBLICATION_ATTEMPTS - 1) {
                return started;
              }
              await Bun.sleep(CONTAINER_PUBLICATION_RETRY_MS);
            }
            break;
          default:
            started.error.kind satisfies never;
            panic("Unrecognized Docker startup failure");
        }
      }
    } finally {
      rmSync(envDirectory, { recursive: true, force: true });
    }
  }
  const owned = docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "dev.stella.shared-test-postgres"}}',
    CONTAINER,
  ]);
  if (owned.isErr()) {
    return owned;
  }
  if (owned.value !== "true") {
    return Result.err(
      new SharedTestPostgresError({
        message: "Container name is occupied by an unowned Postgres instance.",
      }),
    );
  }
  const started = docker(["start", CONTAINER]);
  if (started.isErr()) {
    return started;
  }
  for (let attempt = 0; ; attempt++) {
    const ready = docker([
      "exec",
      CONTAINER,
      "pg_isready",
      "-h",
      "127.0.0.1",
      "-U",
      OWNER,
      "-d",
      "postgres",
    ]);
    if (ready.isOk()) {
      break;
    }
    if (attempt === 59) {
      return Result.err(
        new SharedTestPostgresError({
          message: "Shared Postgres did not become ready.",
        }),
      );
    }
    await Bun.sleep(1000);
  }
  const configured = docker(
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      OWNER,
      "-d",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    "SELECT 1;\n",
  );
  if (configured.isErr()) {
    return configured;
  }
  return Result.ok("ready" as const);
};

type EnsureContainerResult = Awaited<
  ReturnType<typeof ensureContainerUnlocked>
>;

export const ensureContainer = async (options: EnsureContainerOptions) => {
  // SQLite owns release on process death; never unlink its stable lock inode.
  const locked = await withGenerationLock<EnsureContainerResult>({
    lockPath: path.join(options.state, "container.lock"),
    waitTimeoutMs: CONTAINER_CREATION_LOCK_TIMEOUT_MS,
    run: async () => ensureContainerUnlocked(options),
  });
  if (locked.isErr()) {
    return Result.err(
      new SharedTestPostgresError({
        message: "Cannot acquire shared Postgres container creation lock.",
        cause: locked.error,
      }),
    );
  }
  return locked.value;
};

export const withSharedTestPostgresConnection = async <T>(
  url: string,
  work: (connection: ReservedSQL) => Promise<T>,
) => {
  const client = new SQL({ url, max: 1 });
  try {
    const connection = await client.reserve();
    try {
      return await work(connection);
    } finally {
      connection.release();
    }
  } finally {
    await client.close();
  }
};

type ReadDockerResultOptions = {
  result: Pick<
    Bun.ReadableSyncSubprocess,
    "success" | "exitCode" | "stdout" | "stderr"
  >;
  action: string;
  secretValues: readonly string[];
};

export const readDockerResult = ({
  result,
  action,
  secretValues,
}: ReadDockerResultOptions) => {
  if (result.success) {
    return Result.ok(result.stdout.toString().trim());
  }
  const stderr = result.stderr.toString();
  const kind =
    action === "run" &&
    stderr.includes(`The container name "/${CONTAINER}" is already in use`)
      ? DOCKER_FAILURE_KIND.nameConflict
      : DOCKER_FAILURE_KIND.commandFailed;
  let diagnostic = stderr;
  // Mask the whole env payload before its contained password, including JSON output.
  for (const secret of secretValues.toSorted(
    (left, right) => right.length - left.length,
  )) {
    diagnostic = diagnostic.replaceAll(secret, "[redacted]");
  }
  return Result.err(
    new SharedPostgresDockerError({
      kind,
      message: `Shared Postgres Docker ${action} failed (exit ${result.exitCode}): ${diagnostic.trim()}`,
    }),
  );
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
        return Result.err(
          new SharedTestPostgresError({
            message: "Invalid shared worktree registry identity.",
          }),
        );
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
        return Result.err(present.error);
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
      typeof template !== "string" ||
      typeof key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(key) ||
      template !== sharedTestTemplateName(key)
    ) {
      return Result.err(
        new SharedTestPostgresError({
          message: "Invalid shared template registry identity.",
        }),
      );
    }
    await session.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
    await session`DELETE FROM stella_shared_test.templates WHERE history_key = ${key}`;
    rmSync(path.join(state, "histories", key), {
      recursive: true,
      force: true,
    });
  }
  return Result.ok(undefined);
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
    return Result.ok({ key: history.key, template });
  }
  await session`INSERT INTO stella_shared_test.templates (history_key, template_name, status)
    VALUES (${history.key}, ${template}, ${TEMPLATE_STATUS.building}) ON CONFLICT (history_key) DO NOTHING`;
  // Retry only an incomplete template, which has never been handed to a worker.
  await session.unsafe(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
  await session.unsafe(`CREATE DATABASE "${template}" OWNER "${OWNER}"`);
  const snapshot = snapshotSharedTestMigrations(
    history,
    path.join(state, "histories"),
  );
  if (snapshot.isErr()) {
    return snapshot;
  }
  const folder = snapshot.value;
  const configured = docker(
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
      "--set",
      "ON_ERROR_STOP=1",
      "--set",
      `owner=${OWNER}`,
    ],
    `SET ROLE stella_bootstrap;\n${readFileSync(path.join(repo, "docker/postgres/init.sql"), "utf-8")}`,
  );
  if (configured.isErr()) {
    return configured;
  }
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
    return Result.err(
      new SharedTestPostgresError({
        message: `Worker template migration failed (exit ${migrated.exitCode}); credential-bearing output withheld.`,
      }),
    );
  }
  await session`UPDATE stella_shared_test.templates SET status = ${TEMPLATE_STATUS.ready} WHERE history_key = ${history.key}`;
  return Result.ok({ key: history.key, template });
};

const migrateWorkerOnline = (tree: string, url: string) => {
  if (
    !existsSync(path.join(tree, "apps/api/node_modules/better-result")) ||
    !existsSync(path.join(tree, "apps/api/src/db/migrate.ts"))
  ) {
    return Result.ok(undefined);
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
    return Result.err(
      new SharedTestPostgresError({
        message: `Worker revision online migration failed (exit ${migrated.exitCode}); credential-bearing output withheld.`,
      }),
    );
  }
  return Result.ok(undefined);
};

const run = async () => {
  const [action, flag, tree] = process.argv.slice(2);
  if (
    (action !== "prepare" && action !== "drop" && action !== "gc") ||
    (action !== "gc" && (flag !== "--tree" || !tree))
  ) {
    return Result.err(
      new SharedTestPostgresError({
        message:
          "Usage: shared-test-postgres.sh prepare|drop --tree PATH, or gc",
      }),
    );
  }
  const workerTree = tree ? realpathSync(tree) : "";
  const database = sharedTestDatabase(workerTree);
  const state = path.join(
    homedir(),
    ".local/state/stella/shared-test-postgres",
  );
  const credential = sharedTestCredential(state, "owner.password");
  if (credential.isErr()) {
    return credential;
  }
  const password = credential.value;
  const repo = path.resolve(import.meta.dir, "../../..");
  const resolved = resolveDockerTarget({ env: process.env });
  if (resolved.isErr()) {
    return resolved;
  }
  using target = resolved.value;
  const keeper = resolveInstalledDevDockerKeeper(target);
  if (keeper.isErr()) {
    return keeper;
  }
  const docker = (args: DockerArguments, input?: string) => {
    const result = Bun.spawnSync(["docker", "--host", target.host, ...args], {
      env: target.env,
      stdin: input ? Buffer.from(input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return readDockerResult({
      result,
      action: args[0],
      secretValues: [password],
    });
  };
  const startContainer = (envFile: string) => {
    const environment = readFileSync(envFile, "utf-8");
    const result = Bun.spawnSync(
      [
        "docker",
        "--host",
        target.host,
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
        "--",
        IMAGE,
        "postgres",
        "-c",
        "config_file=/etc/postgresql/server.conf",
        "-c",
        "shared_buffers=64MB",
        "-c",
        "max_connections=100",
      ],
      { env: target.env, stdout: "pipe", stderr: "pipe" },
    );
    return readDockerResult({
      result,
      action: "run",
      secretValues: [environment, JSON.stringify(environment), password],
    });
  };
  const container = await ensureContainer({
    docker,
    startContainer,
    state,
    password,
    repo,
    action,
  });
  if (container.isErr()) {
    return container;
  }
  if (container.value === "absent") {
    return Result.ok(undefined);
  }
  return await withSharedTestPostgresConnection(
    `postgres://${OWNER}:${password}@127.0.0.1:${PORT}/postgres`,
    async (session) =>
      await withSharedPostgresLock(session, async () => {
        await initializeTemplateRegistry(session);
        if (action === "gc") {
          return await collectUnusedTemplates(session, state);
        }
        if (action === "drop") {
          await session.unsafe(
            `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
          );
          rmSync(path.join(state, `${database}.url`), { force: true });
          await session`DELETE FROM stella_shared_test.worktrees WHERE database_name = ${database}`;
          return await collectUnusedTemplates(session, state);
        }
        const prepared = await ensureWorkerTemplate({
          session,
          docker,
          state,
          tree: workerTree,
          repo,
          password,
        });
        if (prepared.isErr()) {
          return prepared;
        }
        const { key, template } = prepared.value;
        const registered =
          await session`SELECT history_key FROM stella_shared_test.worktrees WHERE database_name = ${database}`;
        if (registered.length && registered.at(0)?.["history_key"] !== key) {
          return Result.err(
            new SharedTestPostgresError({
              message:
                "Worker migration history changed; drop its test database before preparing again.",
            }),
          );
        }
        const databases =
          await session`SELECT datname FROM pg_database WHERE datname = ${database}`;
        if (databases.length !== 0 && registered.length === 0) {
          return Result.err(
            new SharedTestPostgresError({
              message:
                "Unregistered worker database exists; drop it before preparing again.",
            }),
          );
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
          return Result.err(
            new SharedTestPostgresError({
              message:
                "Shared test database owner has an invalid privilege posture.",
            }),
          );
        }
        await session`INSERT INTO stella_shared_test.worktrees (database_name, tree_path, history_key)
        VALUES (${database}, ${workerTree}, ${key})
        ON CONFLICT (database_name) DO UPDATE SET tree_path = EXCLUDED.tree_path`;
        if (sharedTestMigrationHistory(workerTree).key !== key) {
          return Result.err(
            new SharedTestPostgresError({
              message:
                "Worker migrations changed during preparation; drop and prepare its test database again.",
            }),
          );
        }
        const migrated = migrateWorkerOnline(workerTree, url);
        if (migrated.isErr()) {
          return migrated;
        }
        const urlFile = path.join(state, `${database}.url`);
        const temporary = path.join(
          state,
          `.url-write-${randomBytes(16).toString("hex")}`,
        );
        writeFileSync(temporary, url, { flag: "wx", mode: 0o600 });
        renameSync(temporary, urlFile);
        const collected = await collectUnusedTemplates(session, state);
        if (collected.isErr()) {
          return collected;
        }
        process.stdout.write(
          `${JSON.stringify({ database, urlFile, template })}\n`,
        );
        return Result.ok(undefined);
      }),
  );
};

if (import.meta.main) {
  const attempted = await Result.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof SharedTestPostgresError
        ? cause
        : new SharedTestPostgresError({
            message:
              "Shared test Postgres provisioning failed; inspect the host Docker service and private state.",
          }),
  });
  const result = attempted.isErr() ? attempted : attempted.value;
  if (result.isErr()) {
    process.stderr.write(`${result.error.message}\n`);
    process.exitCode = 1;
  }
}
