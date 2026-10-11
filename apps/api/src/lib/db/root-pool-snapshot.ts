import { panic, Result, TaggedError } from "better-result";
import type { SQL } from "bun";

const SNAPSHOT_RESERVATION_TIMEOUT_MS = 1000;
const SNAPSHOT_QUERY_TIMEOUT_MS = 1000;

// The observer's connection is excluded from in-use counts. The application
// name is unique to this root pool and is never included in the log record.
// Its slot is counted as idle, as it will be once the observation releases it.
const ROOT_POOL_SNAPSHOT_SQL = `
  SELECT count(*)::integer AS size,
    (count(*) FILTER (WHERE state <> 'idle' AND pid <> pg_backend_pid()))::integer AS "inUse",
    (count(*) FILTER (WHERE state = 'idle' OR pid = pg_backend_pid()))::integer AS idle
  FROM pg_stat_activity
  WHERE application_name = current_setting('application_name')
    AND datname = current_database()
`;

class RootPoolSnapshotError extends TaggedError("RootPoolSnapshotError")<{
  message: string;
  cause: unknown;
}> {}

export const readRootPoolSnapshot = (client: Pick<SQL, "reserve">) =>
  Result.tryPromise({
    try: async () => {
      using session = await client.reserve({
        signal: AbortSignal.timeout(SNAPSHOT_RESERVATION_TIMEOUT_MS),
      });
      const query = session.unsafe<
        {
          size: number;
          inUse: number;
          idle: number;
        }[]
      >(ROOT_POOL_SNAPSHOT_SQL);
      const timer = setTimeout(() => {
        query.cancel();
      }, SNAPSHOT_QUERY_TIMEOUT_MS);
      try {
        const rows = await query;
        const row = rows.at(0);
        if (row === undefined) {
          return panic("Root pool snapshot returned no aggregate");
        }
        return row;
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) =>
      new RootPoolSnapshotError({
        message: "Root pool snapshot unavailable",
        cause,
      }),
  });
