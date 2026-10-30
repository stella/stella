import { panic, Result } from "better-result";

import { openBoundedDatabaseObserver } from "../src/db/online-index-observer";

const SAMPLE_INTERVAL_MS = 100;
const MAX_SAMPLES = 4;
const MAX_REPORT_CHARACTERS = 16_384;
const MAX_SAMPLE_CHARACTERS = 4096;

const boundSnapshot = (snapshot: string) => {
  if (snapshot.length <= MAX_SAMPLE_CHARACTERS) {
    return snapshot;
  }
  const parsed = Result.try(() => JSON.parse(snapshot));
  if (
    parsed.isOk() &&
    typeof parsed.value === "object" &&
    parsed.value !== null
  ) {
    const summary = JSON.stringify(
      {
        truncated: true,
        waiters: Reflect.get(parsed.value, "waiters"),
        activity: Reflect.get(parsed.value, "activity"),
        locks: Reflect.get(parsed.value, "locks"),
      },
      (key, value) => (key === "query" ? undefined : value),
    );
    if (summary.length <= MAX_SAMPLE_CHARACTERS) {
      return summary;
    }
    const waiters = JSON.stringify({
      truncated: true,
      waiters: Reflect.get(parsed.value, "waiters"),
    });
    if (waiters.length <= MAX_SAMPLE_CHARACTERS) {
      return waiters;
    }
  }
  return JSON.stringify({ truncated: true, preview: snapshot.slice(0, 1024) });
};

// Capture while the waiter is blocked: after 55P03 its waiting lock and
// pg_blocking_pids disappear. Limit both the catalog reads and retained output.
export const POSTGRES_LOCK_SNAPSHOT_SQL = `
WITH waiters AS MATERIALIZED (
  SELECT pid, pg_blocking_pids(pid) AS blockers
  FROM pg_stat_activity
  WHERE datname = current_database() AND wait_event_type = 'Lock'
  ORDER BY query_start LIMIT 8
), participants AS (
  SELECT pid FROM waiters UNION SELECT unnest(blockers) FROM waiters
), activity AS (
  SELECT a.pid, a.backend_type, a.state, a.wait_event_type, a.wait_event,
    a.xact_start, a.query_start, left(a.query, 512) AS query
  FROM pg_stat_activity a JOIN participants p USING (pid)
  ORDER BY a.pid LIMIT 24
), locks AS (
  SELECT l.pid, l.locktype, l.mode, l.granted, l.database, l.relation,
    l.virtualxid, l.transactionid
  FROM pg_locks l JOIN participants p USING (pid)
  ORDER BY l.granted, l.pid, l.locktype LIMIT 64
)
SELECT json_build_object(
  'sampled_at', clock_timestamp(),
  'waiters', (SELECT coalesce(json_agg(waiters), '[]') FROM waiters),
  'activity', (SELECT coalesce(json_agg(activity), '[]') FROM activity),
  'locks', (SELECT coalesce(json_agg(locks), '[]') FROM locks),
  'observer_settings', (SELECT json_agg(s) FROM (
    SELECT name, setting, unit, source FROM pg_settings
    WHERE name IN ('autovacuum', 'deadlock_timeout', 'lock_timeout')
    ORDER BY name
  ) s)
)::text AS snapshot
WHERE EXISTS (SELECT 1 FROM waiters)`;

type StartLockMonitorOptions = {
  capture: () => Promise<readonly { snapshot: string }[]>;
  intervalMs?: number;
};

export const startLockMonitor = ({
  capture,
  intervalMs = SAMPLE_INTERVAL_MS,
}: StartLockMonitorOptions) => {
  const samples: string[] = [];
  let failure = "";
  let pending: Promise<void> | undefined;
  const sample = async () => {
    const result = await Result.tryPromise(capture);
    if (result.isErr()) {
      failure = result.error.message.slice(0, 512);
      return;
    }
    for (const { snapshot } of result.value) {
      samples.push(boundSnapshot(snapshot));
      if (samples.length > MAX_SAMPLES) {
        samples.shift();
      }
    }
  };
  const timer = setInterval(() => {
    if (pending !== undefined || failure !== "") {
      return;
    }
    pending = sample().finally(() => {
      pending = undefined;
    });
  }, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      await pending;
      const retained = [...samples];
      let report = JSON.stringify({
        samples: retained,
        captureFailure: failure,
      });
      while (report.length > MAX_REPORT_CHARACTERS && retained.length > 1) {
        retained.shift();
        report = JSON.stringify({ samples: retained, captureFailure: failure });
      }
      return report;
    },
  };
};

type PostgresTestProcessOptions = {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: "inherit";
  stdout: "inherit";
  stderr: "inherit";
};

type ObservePostgresTestProcessOptions = {
  child: {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  };
  capture: StartLockMonitorOptions["capture"];
  intervalMs?: number;
  writeStdout: (chunk: Uint8Array) => void;
  writeStderr: (chunk: Uint8Array) => void;
  reportFailure: (report: string) => void;
};

export const observePostgresTestProcess = async ({
  child,
  capture,
  intervalMs,
  writeStdout,
  writeStderr,
  reportFailure,
}: ObservePostgresTestProcessOptions) => {
  const monitor = startLockMonitor({
    capture,
    ...(intervalMs === undefined ? {} : { intervalMs }),
  });
  const diagnostics = { lockTimeoutObserved: false };
  const forward = async (
    stream: ReadableStream<Uint8Array>,
    write: (chunk: Uint8Array) => void,
  ) => {
    let suffix = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = suffix + decoder.decode(chunk, { stream: true });
      diagnostics.lockTimeoutObserved ||= text.includes("55P03");
      suffix = text.slice(-4);
      write(chunk);
    }
  };
  return (async () => {
    try {
      const [status] = await Promise.all([
        child.exited,
        forward(child.stdout, writeStdout),
        forward(child.stderr, writeStderr),
      ]);
      const report = await monitor.stop();
      if (status !== 0 && diagnostics.lockTimeoutObserved) {
        reportFailure(`Postgres lock timeout diagnostics: ${report}`);
      }
      return status;
    } finally {
      await monitor.stop();
    }
  })();
};

/** Preserve streamed test output and exit status; diagnostics never retry tests. */
export const spawnPostgresTestProcess = (
  options: PostgresTestProcessOptions,
) => {
  const databaseUrl =
    options.env["DATABASE_URL"] ?? panic("Missing DATABASE_URL");
  const observer = Result.tryPromise(
    async () =>
      await openBoundedDatabaseObserver({
        url: databaseUrl,
        applicationName: "stella_test_lock_observer",
        statementTimeoutMs: 1000,
        lockTimeoutMs: 100,
      }),
  );
  const child = Bun.spawn({ ...options, stdout: "pipe", stderr: "pipe" });
  const observed = observePostgresTestProcess({
    child,
    capture: async () => {
      const connection = (await observer).unwrap(
        "PostgreSQL lock observer must be connected before sampling",
      );
      const rows = await connection.query(POSTGRES_LOCK_SNAPSHOT_SQL);
      return rows.map((row) => {
        if (
          typeof row !== "object" ||
          row === null ||
          !("snapshot" in row) ||
          typeof row.snapshot !== "string"
        ) {
          return panic("Expected a PostgreSQL lock snapshot string");
        }
        return { snapshot: row.snapshot };
      });
    },
    writeStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    writeStderr: (chunk) => {
      process.stderr.write(chunk);
    },
    reportFailure: (report) => {
      console.error(report);
    },
  });
  const exited = (async () => {
    try {
      return await observed;
    } finally {
      const connection = await observer;
      if (connection.isOk()) {
        await connection.value.release();
      }
    }
  })();
  return {
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    // A runner's interrupt must reach the test process, or it keeps its
    // database connections open after the run.
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
};
