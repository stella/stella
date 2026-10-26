import { TaggedError } from "better-result";

import { sha256Hex } from "@stll/sha256/bun";

import { partitionTestFiles } from "./test-file-shards";

export const POSTGRES_TEST_CONNECTION_RESERVE = 10;
// PostgreSQL truncates identifiers to NAMEDATALEN - 1 bytes without an error.
export const POSTGRES_IDENTIFIER_BYTES = 63;
export const POSTGRES_TEST_POOL_MAX_PER_WORKER = 10;

export class PostgresWorkerBudgetError extends TaggedError(
  "PostgresWorkerBudgetError",
)<{ message: string; maxConnections: number; requestedConnections: number }> {}

export class PostgresTemplateConnectionError extends TaggedError(
  "PostgresTemplateConnectionError",
)<{ message: string; connections: string[] }> {}

export class PostgresWorkerCountError extends TaggedError(
  "PostgresWorkerCountError",
)<{ message: string }> {}

type WorkerPlan = { batches: string[][]; seconds: number };

type PlanPostgresWorkersOptions = {
  files: readonly string[];
  durations: Readonly<Record<string, number>>;
  exclusivePaths: ReadonlySet<string>;
  workers: number;
};

export const planPostgresWorkers = ({
  files,
  durations,
  exclusivePaths,
  workers,
}: PlanPostgresWorkersOptions): WorkerPlan[] => {
  if (!Number.isSafeInteger(workers) || workers <= 0) {
    throw new PostgresWorkerCountError({
      message: "--workers must be a positive integer",
    });
  }
  const ordinary = files.filter((file) => !exclusivePaths.has(file));
  const exclusive = files.filter((file) => exclusivePaths.has(file));
  const ordinaryPlans = partitionTestFiles({
    files: ordinary,
    durations,
    count: workers,
  }).map((workerFiles) => ({
    batches: workerFiles.length === 0 ? [] : [workerFiles],
    seconds: workerFiles.reduce((sum, file) => sum + (durations[file] ?? 5), 0),
  }));
  for (const file of exclusive) {
    const target = ordinaryPlans
      .toSorted((left, right) => left.seconds - right.seconds)
      .at(0);
    if (target === undefined) {
      break;
    }
    target.batches.push([file]);
    target.seconds += durations[file] ?? 5;
  }
  return ordinaryPlans;
};

export const assertPostgresWorkerBudget = ({
  workers,
  poolMaxPerWorker,
  maxConnections,
  reserve = POSTGRES_TEST_CONNECTION_RESERVE,
}: {
  workers: number;
  poolMaxPerWorker: number;
  maxConnections: number;
  reserve?: number;
}) => {
  const requestedConnections = workers * poolMaxPerWorker;
  if (
    !Number.isSafeInteger(maxConnections) ||
    maxConnections <= 0 ||
    requestedConnections > maxConnections - reserve
  ) {
    throw new PostgresWorkerBudgetError({
      message: `${workers} Postgres test workers require ${requestedConnections} connections, but max_connections=${maxConnections} reserves ${reserve}`,
      maxConnections,
      requestedConnections,
    });
  }
};

export type PostgresAdmin = {
  query: (sql: string, parameters?: readonly unknown[]) => Promise<unknown[]>;
  close: () => Promise<void>;
};

/**
 * A clone name that fits PostgreSQL's identifier limit: the template prefix is
 * shortened by whole characters, and the worker number plus a hash of the
 * template and run keep every clone of every run distinct.
 */
export const workerDatabaseName = ({
  template,
  runId,
  worker,
}: {
  template: string;
  runId: string;
  worker: number;
}) => {
  const tail = `_w${worker}_${sha256Hex(`${template}\0${runId}`).slice(0, 12)}`;
  // Trim whole graphemes so the byte budget never splits a character.
  const head = Array.from(
    new Intl.Segmenter().segment(`${template}_test`),
    ({ segment }) => segment,
  );
  while (
    head.length > 0 &&
    Buffer.byteLength(head.join("") + tail) > POSTGRES_IDENTIFIER_BYTES
  ) {
    head.pop();
  }
  return head.join("") + tail;
};

type Child = {
  exited: Promise<number>;
  exitCode: number | null;
  signalCode: string | number | null;
  kill: (signal?: NodeJS.Signals) => void;
};

type RunPostgresWorkersOptions = PlanPostgresWorkersOptions & {
  clusterExclusivePaths?: ReadonlySet<string>;
  databaseUrl: string;
  poolMaxPerWorker?: number;
  reserve?: number;
  admin: PostgresAdmin;
  runWorker: (options: {
    files: readonly string[];
    databaseUrl: string;
    worker: number;
  }) => Child;
  registerSignal?: (handler: (signal: NodeJS.Signals) => void) => () => void;
  now?: () => number;
  log?: (message: string) => void;
};

const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

const databaseUrlWithName = (source: URL, databaseName: string) => {
  const result = new URL(source);
  result.pathname = `/${databaseName}`;
  return result.toString();
};

export const runPostgresWorkers = async ({
  files,
  durations,
  exclusivePaths,
  clusterExclusivePaths = new Set(),
  workers,
  databaseUrl,
  poolMaxPerWorker = POSTGRES_TEST_POOL_MAX_PER_WORKER,
  reserve = POSTGRES_TEST_CONNECTION_RESERVE,
  admin,
  runWorker,
  registerSignal = (handler) => {
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of signals) {
      process.once(signal, handler);
    }
    return () => {
      for (const signal of signals) {
        process.off(signal, handler);
      }
    };
  },
  now = Date.now,
  log = console.log,
}: RunPostgresWorkersOptions): Promise<number> => {
  const templateUrl = new URL(databaseUrl);
  const template = decodeURIComponent(templateUrl.pathname.slice(1));
  if (template.length === 0) {
    throw new PostgresWorkerCountError({
      message: "DATABASE_URL must name a database",
    });
  }
  const maxRow = await admin
    .query("SHOW max_connections")
    .then((rows) => rows.at(0));
  const maxConnections = Number(
    typeof maxRow === "object" && maxRow !== null && "max_connections" in maxRow
      ? maxRow.max_connections
      : Number.NaN,
  );
  assertPostgresWorkerBudget({
    workers,
    poolMaxPerWorker,
    maxConnections,
    reserve,
  });

  const applicationName = `stella-postgres-runner-${process.pid}`;
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = $2 AND pid <> pg_backend_pid()",
    [template, applicationName],
  );
  const foreignRows = await admin.query(
    "SELECT pid, application_name, client_addr::text FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY pid",
    [template],
  );
  const foreign = foreignRows.flatMap((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("pid" in row) ||
      !("application_name" in row) ||
      !("client_addr" in row)
    ) {
      return [];
    }
    return [
      {
        pid: Number(row.pid),
        application_name: String(row.application_name),
        client_addr:
          typeof row.client_addr === "string" ? row.client_addr : null,
      },
    ];
  });
  if (foreign.length > 0) {
    const connections = foreign.map(
      ({ pid, application_name, client_addr }) =>
        `pid=${pid} application_name=${application_name || "<unset>"} client_addr=${client_addr ?? "local"}`,
    );
    throw new PostgresTemplateConnectionError({
      message: `Template database ${template} has foreign connections: ${connections.join("; ")}`,
      connections,
    });
  }

  const clusterFiles = files.filter((file) => clusterExclusivePaths.has(file));
  const plan = planPostgresWorkers({
    files: files.filter((file) => !clusterExclusivePaths.has(file)),
    durations,
    exclusivePaths,
    workers,
  });
  const runId = `${process.pid}_${Date.now().toString(36)}`;
  const databaseNames = plan.map((_, index) =>
    workerDatabaseName({ template, runId, worker: index + 1 }),
  );
  const children: Child[] = [];
  let signal: NodeJS.Signals | undefined;
  const unregister = registerSignal((received) => {
    signal = received;
    for (const child of children) {
      child.kill(received);
    }
  });
  try {
    for (const databaseName of databaseNames) {
      await admin.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE ${quoteIdentifier(template)}`,
      );
    }
    const started = plan.map(() => now());
    const runBatch = async (batch: readonly string[], index: number) => {
      const child = runWorker({
        files: batch,
        databaseUrl: databaseUrlWithName(
          templateUrl,
          databaseNames.at(index) ?? "",
        ),
        worker: index + 1,
      });
      children.push(child);
      return await child.exited;
    };
    const statuses = await Promise.all(
      plan.map(async (workerPlan, index) => {
        let firstFailure = 0;
        for (const batch of workerPlan.batches) {
          if (signal !== undefined) {
            break;
          }
          const status = await runBatch(batch, index);
          if (firstFailure === 0 && status !== 0) {
            firstFailure = status;
          }
        }
        return firstFailure;
      }),
    );
    for (const [index, workerPlan] of plan.entries()) {
      const wallSeconds = (now() - (started.at(index) ?? now())) / 1000;
      const fileCount = workerPlan.batches.reduce(
        (sum, batch) => sum + batch.length,
        0,
      );
      log(
        `Postgres worker ${index + 1}: ${wallSeconds.toFixed(1)}s (${fileCount} files, projected ${workerPlan.seconds.toFixed(1)}s)`,
      );
    }
    // Role grants are cluster-wide even when each worker has its own database.
    // Drain every worker before replaying bundles, one complete suite at a time.
    for (const file of clusterFiles) {
      if (signal !== undefined) {
        break;
      }
      const clusterStarted = now();
      statuses.push(await runBatch([file], 0));
      log(
        `Postgres cluster migration ${file}: ${((now() - clusterStarted) / 1000).toFixed(1)}s`,
      );
    }
    const slowest = [...files]
      .toSorted(
        (left, right) => (durations[right] ?? 5) - (durations[left] ?? 5),
      )
      .slice(0, 10);
    log(
      `Slowest Postgres files: ${slowest.map((file) => `${file} (${(durations[file] ?? 5).toFixed(1)}s)`).join(", ")}`,
    );
    if (signal !== undefined) {
      return 128 + (signal === "SIGINT" ? 2 : 15);
    }
    return statuses.find((status) => status !== 0) ?? 0;
  } finally {
    unregister();
    for (const databaseName of databaseNames.toReversed()) {
      // Only client sessions: an owner role may not terminate autovacuum
      // workers, and DROP DATABASE already stops those on its own.
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'",
        [databaseName],
      );
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      );
    }
    await admin.close();
  }
};

export const parsePostgresWorkerCount = (
  arguments_: readonly string[],
  fallback = 4,
) => {
  const index = arguments_.findIndex(
    (argument) => argument === "--workers" || argument.startsWith("--workers="),
  );
  if (index === -1) {
    return { workers: fallback, arguments: [...arguments_] };
  }
  const argument = arguments_.at(index) ?? "";
  const value = argument.includes("=")
    ? argument.slice(argument.indexOf("=") + 1)
    : arguments_.at(index + 1);
  const workers = Number(value);
  if (!Number.isSafeInteger(workers) || workers <= 0) {
    throw new PostgresWorkerCountError({
      message: "--workers must be a positive integer",
    });
  }
  const remove = argument.includes("=") ? 1 : 2;
  return { workers, arguments: arguments_.toSpliced(index, remove) };
};
