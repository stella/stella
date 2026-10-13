import { Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
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

import {
  resolveDockerTarget,
  resolveInstalledDevDockerKeeper,
} from "./dev-docker";
import { withSharedPostgresLock } from "./dev-postgres-lock";

class SharedTestPostgresError extends TaggedError("SharedTestPostgresError")<{
  message: string;
}> {}

const CONTAINER = "stella-shared-test-postgres";
const IMAGE = "stella-shared-test-postgres:18";
const PORT = 15_432;
const OWNER = "stella_test_owner";
const TEMPLATE = "stella_test_template";

export const sharedTestDatabase = (tree: string) =>
  `stella_test_${sha256Hex(tree).slice(0, 24)}`;

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
  action: "prepare" | "drop";
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
  if (!exists && action === "drop") {
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

const run = async () => {
  const [action, flag, tree] = process.argv.slice(2);
  if (
    (action !== "prepare" && action !== "drop") ||
    flag !== "--tree" ||
    !tree
  ) {
    throw new SharedTestPostgresError({
      message: "Usage: shared-test-postgres.sh prepare|drop --tree PATH",
    });
  }
  const database = sharedTestDatabase(realpathSync(tree));
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
      if (action === "drop") {
        await session.unsafe(
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        );
        rmSync(path.join(state, `${database}.url`), { force: true });
        return;
      }
      const templates =
        await session`SELECT datname FROM pg_database WHERE datname = ${TEMPLATE}`;
      if (templates.length === 0) {
        await session.unsafe(`CREATE DATABASE "${TEMPLATE}" OWNER "${OWNER}"`);
      }
      // Bootstrap extensions in each database; application migrations run once
      // in the template so cluster-wide role creation never repeats per worker.
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
          TEMPLATE,
          "-v",
          "ON_ERROR_STOP=1",
          "-v",
          `owner=${OWNER}`,
        ],
        `SET ROLE stella_bootstrap;\n${readFileSync(path.join(repo, "docker/postgres/init.sql"), "utf-8")}`,
      );
      const templateUrl = `postgres://${OWNER}:${password}@127.0.0.1:${PORT}/${TEMPLATE}`;
      const migrate = (root: string, url: string) => {
        const migrated = Bun.spawnSync(["bun", "run", "src/db/migrate.ts"], {
          cwd: path.join(root, "apps/api"),
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
            message: `Shared test database migrations failed (exit ${migrated.exitCode}); output is withheld because it can contain credentials.`,
          });
        }
      };
      migrate(repo, templateUrl);
      const databases =
        await session`SELECT datname FROM pg_database WHERE datname = ${database}`;
      if (databases.length === 0) {
        await session.unsafe(
          `CREATE DATABASE "${database}" TEMPLATE "${TEMPLATE}" OWNER "${OWNER}"`,
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
      // Checkout hooks run before dependency installation. The installed canonical
      // checkout seeds those workers; an installed worker migrates its own revision.
      const migrationRoot = existsSync(
        path.join(tree, "apps/api/node_modules/better-result"),
      )
        ? tree
        : repo;
      migrate(migrationRoot, url);
      const urlFile = path.join(state, `${database}.url`);
      const temporary = path.join(
        state,
        `.url-write-${randomBytes(16).toString("hex")}`,
      );
      writeFileSync(temporary, url, { flag: "wx", mode: 0o600 });
      renameSync(temporary, urlFile);
      process.stdout.write(`${JSON.stringify({ database, urlFile })}\n`);
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
