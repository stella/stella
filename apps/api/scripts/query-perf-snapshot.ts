import { TaggedError } from "better-result";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { createSha256 } from "@stll/sha256/node";

import {
  QUERY_PERF_PROFILES,
  queryPerfDatabaseName,
} from "../src/tests/query-perf/profiles";
import type { QueryPerfProfileId } from "../src/tests/query-perf/profiles";
import { SYNTHETIC_TABLES } from "../src/tests/query-perf/synthetic/tables";
import { snapshotInputPaths } from "./test-db-snapshot-cache";

const SNAPSHOT_FORMAT = "query-perf-pg-data-v2";

export class QueryPerfSnapshotError extends TaggedError(
  "QueryPerfSnapshotError",
)<{
  message: string;
}> {}

const parseProfileId = (value: string): QueryPerfProfileId => {
  const profileId = QUERY_PERF_PROFILES.find((profile) => profile === value);
  if (profileId !== undefined) {
    return profileId;
  }
  throw new QueryPerfSnapshotError({
    message: "Invalid query performance profile ID",
  });
};

export const fixtureConnectionEnvironment = (
  databaseUrl: string,
  profileId: QueryPerfProfileId,
) => {
  const url = new URL(databaseUrl);
  const databaseName = queryPerfDatabaseName(profileId);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== `/${databaseName}` ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new QueryPerfSnapshotError({
      message:
        "Snapshot operations require a loopback PostgreSQL URL for the selected query performance profile without query parameters",
    });
  }
  return {
    PGHOST: url.hostname === "[::1]" ? "::1" : url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: databaseName,
    PGUSER: decodeURIComponent(url.username) || "postgres",
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: "disable",
    PGCONNECT_TIMEOUT: "5",
  };
};

const treeFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...treeFiles(file));
    } else if (entry.isFile()) {
      files.push(file);
    } else {
      throw new QueryPerfSnapshotError({
        message: "Snapshot inputs must be regular files or directories",
      });
    }
  }
  return files;
};

type QueryPerfSnapshotKeyOptions = {
  repositoryRoot: string;
  seedEntry: string;
  settingsFile: string;
  pgMajor: number;
  profileId: QueryPerfProfileId;
};

export const queryPerfSnapshotKey = ({
  repositoryRoot,
  seedEntry,
  settingsFile,
  pgMajor,
  profileId,
}: QueryPerfSnapshotKeyOptions) => {
  if (!Number.isSafeInteger(pgMajor) || pgMajor < 18) {
    throw new QueryPerfSnapshotError({
      message: "A PostgreSQL major version of at least 18 is required",
    });
  }
  const root = path.resolve(repositoryRoot);
  const inputs = new Set([
    ...snapshotInputPaths(root, path.resolve(root, seedEntry)),
    ...treeFiles(path.join(root, "apps/api/src/tests/query-perf/synthetic")),
    path.resolve(root, settingsFile),
    path.join(root, "apps/api/scripts/query-perf-snapshot.ts"),
    path.join(root, "apps/api/scripts/test-db-snapshot-cache.ts"),
  ]);
  const hash = createSha256();
  hash.update(`${SNAPSHOT_FORMAT}\0${profileId}\0${pgMajor}\0`);
  for (const file of [...inputs].toSorted()) {
    const content = readFileSync(file);
    const identity = path.relative(root, file);
    hash.update(`${identity.length}:${identity}${content.length}:`);
    hash.update(content);
  }
  return `${SNAPSHOT_FORMAT}-${profileId}-pg${pgMajor}-${hash.digest("hex")}`;
};

const runPostgres = async (
  command: string[],
  connection: ReturnType<typeof fixtureConnectionEnvironment>,
) => {
  const child = Bun.spawn(command, {
    // Do not inherit libpq overrides such as PGSERVICE, PGOPTIONS or PGHOSTADDR.
    env: { PATH: process.env["PATH"], LANG: "C", ...connection },
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) {
    // libpq diagnostics may contain connection details; report only the operation.
    throw new QueryPerfSnapshotError({
      message: `PostgreSQL ${command.at(0)} operation failed`,
    });
  }
  return output.trim();
};

const query = (
  sql: string,
  connection: ReturnType<typeof fixtureConnectionEnvironment>,
) =>
  runPostgres(
    [
      "psql",
      "--no-password",
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--command",
      sql,
    ],
    connection,
  );

type QueryPerfSnapshotOperationOptions = {
  databaseUrl: string;
  archive: string;
  pgMajor: number;
  profileId: QueryPerfProfileId;
};

const checkedConnection = async ({
  databaseUrl,
  pgMajor,
  profileId,
}: QueryPerfSnapshotOperationOptions) => {
  const connection = fixtureConnectionEnvironment(databaseUrl, profileId);
  const serverMajor = Math.floor(
    Number(await query("SHOW server_version_num", connection)) / 10_000,
  );
  if (serverMajor !== pgMajor) {
    throw new QueryPerfSnapshotError({
      message: "Fixture PostgreSQL major does not match the cache key",
    });
  }
  for (const program of ["pg_dump", "pg_restore"]) {
    const version = await runPostgres([program, "--version"], connection);
    const clientMajor = Number(/PostgreSQL\)? (\d+)/u.exec(version)?.at(1));
    if (clientMajor !== pgMajor) {
      throw new QueryPerfSnapshotError({
        message: "PostgreSQL archive tools must match the cache key major",
      });
    }
  }
  return connection;
};

export const saveQueryPerfSnapshot = async (
  options: QueryPerfSnapshotOperationOptions,
) => {
  const connection = await checkedConnection(options);
  const started = performance.now();
  const archive = path.resolve(options.archive);
  mkdirSync(path.dirname(archive), { recursive: true });
  const temporary = `${archive}.${process.pid}.tmp`;
  try {
    await runPostgres(
      [
        "pg_dump",
        "--no-password",
        "--format=custom",
        "--data-only",
        "--strict-names",
        ...SYNTHETIC_TABLES.flatMap((table) => ["--table", `public.${table}`]),
        "--no-owner",
        "--file",
        temporary,
      ],
      connection,
    );
    renameSync(temporary, archive);
  } finally {
    rmSync(temporary, { force: true });
  }
  return {
    saveMs: Math.round(performance.now() - started),
    archiveBytes: statSync(archive).size,
  };
};

export const restoreQueryPerfSnapshot = async (
  options: QueryPerfSnapshotOperationOptions,
) => {
  const connection = await checkedConnection(options);
  for (const table of SYNTHETIC_TABLES) {
    const populated = await query(
      `SELECT EXISTS (SELECT 1 FROM public."${table}" LIMIT 1)`,
      connection,
    );
    if (populated !== "f") {
      throw new QueryPerfSnapshotError({
        message:
          "Snapshot restore requires empty synthetic tables in a migrated fixture database",
      });
    }
  }
  const started = performance.now();
  await runPostgres(
    [
      "pg_restore",
      "--no-password",
      "--exit-on-error",
      "--single-transaction",
      "--data-only",
      "--disable-triggers",
      "--no-owner",
      "--dbname",
      queryPerfDatabaseName(options.profileId),
      path.resolve(options.archive),
    ],
    connection,
  );
  await query("ANALYZE", connection);
  return {
    restoreMs: Math.round(performance.now() - started),
    archiveBytes: statSync(options.archive).size,
  };
};

const main = async () => {
  const [operation, ...args] = Bun.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    const value = index === -1 ? undefined : args.at(index + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new QueryPerfSnapshotError({ message: `Missing required ${name}` });
    }
    return value;
  };
  const pgMajor = Number(option("--pg-major"));
  const profileId = parseProfileId(option("--profile-id"));
  if (!Number.isSafeInteger(pgMajor) || pgMajor < 18) {
    throw new QueryPerfSnapshotError({ message: "Invalid PostgreSQL major" });
  }
  switch (operation) {
    case "key":
      console.log(
        queryPerfSnapshotKey({
          repositoryRoot: option("--root"),
          seedEntry: option("--seed-entry"),
          settingsFile: option("--settings"),
          pgMajor,
          profileId,
        }),
      );
      return;
    case "save":
    case "restore": {
      const options = {
        databaseUrl: option("--database-url"),
        archive: option("--archive"),
        pgMajor,
        profileId,
      };
      const result =
        operation === "save"
          ? await saveQueryPerfSnapshot(options)
          : await restoreQueryPerfSnapshot(options);
      console.log(JSON.stringify(result));
      return;
    }
    default:
      throw new QueryPerfSnapshotError({
        message: "Expected key, save or restore operation",
      });
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof QueryPerfSnapshotError
        ? error.message
        : "Snapshot operation failed",
    );
    process.exitCode = 1;
  }
}
