import { sql, type SQLWrapper } from "drizzle-orm";

import {
  type DatabaseLoginPosture,
  databaseLoginPostureNotes,
  databaseLoginPostureResult,
} from "@/api/lib/db/rls-role-posture";
import { failureSink } from "@/api/lib/observability/failure";
import { runtimeMode } from "@/api/runtime-mode";

const DATABASE_LOGIN_REFUSED_SINK = failureSink({
  event: "startup.database_login_refused",
  expected: [],
});

type DatabaseLoginPostureDatabase = {
  execute: <TRow extends Record<string, unknown>>(
    query: SQLWrapper | string,
  ) => PromiseLike<readonly TRow[]>;
};

/** Inspect the authenticated login, independently of transaction-local role changes. */
export const readDatabaseLoginPosture = async (
  database: DatabaseLoginPostureDatabase,
): Promise<DatabaseLoginPosture | undefined> => {
  const rows = await database.execute<DatabaseLoginPosture>(sql`
    SELECT login.rolname AS "loginName",
      login.rolbypassrls AS "bypassesRls",
      login.rolsuper AS "isSuperuser",
      (SELECT count(*)::int FROM pg_catalog.pg_class relation
        WHERE relation.relowner = login.oid
          AND relation.relkind IN ('r', 'p')
          AND relation.relrowsecurity) AS "ownedPolicyTables"
    FROM pg_catalog.pg_roles login
    WHERE login.rolname = SESSION_USER
  `);
  return rows.at(0);
};

/** Owner-connection hosts call this before accepting work. */
export const assertDatabaseLoginPosture = async (
  database: DatabaseLoginPostureDatabase,
): Promise<void> => {
  const { logger } = await import("@/api/lib/observability/logger");
  const { envBase } = await import("@/api/env-base");
  const posture = await readDatabaseLoginPosture(database);
  if (posture !== undefined) {
    const notes = databaseLoginPostureNotes(posture);
    if (notes.length > 0) {
      const attributes = { login: posture.loginName, notes: notes.join("; ") };
      if (posture.isSuperuser || posture.bypassesRls) {
        logger.warn("startup.database_login_posture", attributes);
      } else {
        logger.info("startup.database_login_posture", attributes);
      }
    }
  }
  const outcome = databaseLoginPostureResult({
    posture,
    runtimeMode: runtimeMode(),
    unsafeLocalDevOptIn: envBase.STELLA_ALLOW_PRIVILEGED_DB_LOGIN_FOR_LOCAL_DEV,
  });
  if (outcome.isErr()) {
    const { observeFailure } =
      await import("@/api/lib/observability/observe-failure");
    observeFailure(outcome.error, { sink: DATABASE_LOGIN_REFUSED_SINK });
    throw outcome.error;
  }
};
