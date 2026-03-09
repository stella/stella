import "dotenv/config";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  invoiceStatusEnum,
  propertyStatusEnum,
  relations,
  timeEntrySourceEnum,
  timeEntryStatusEnum,
} from "@/api/db/schema";
import { env } from "@/api/env";

// https://github.com/drizzle-team/drizzle-orm/issues/4942
// const client = new SQL(env.DATABASE_URL);

if (!env.DATABASE_APP_URL) {
  // biome-ignore lint/suspicious/noConsole: startup warning
  console.warn(
    "[WARN] DATABASE_APP_URL is not set. " +
      "RLS policies will be bypassed if DATABASE_URL " +
      `uses a superuser role.${env.isDev ? " (dev mode)" : ""}`,
  );
}

/**
 * Primary database handle. When `DATABASE_APP_URL` is set this
 * connects as `stella_app` (RLS-enforced role). All workspace-
 * scoped queries MUST go through `ScopedDb` which sets
 * `app.workspace_ids` per transaction.
 */
export const db = drizzle(env.DATABASE_APP_URL ?? env.DATABASE_URL, {
  relations: { ...relations, ...authRelationsPart },
  schema: {
    propertyStatusEnum,
    timeEntryStatusEnum,
    timeEntrySourceEnum,
    invoiceStatusEnum,
  },
});

/**
 * Admin database handle that always connects as the superuser
 * (via `DATABASE_URL`). Used ONLY for bootstrap queries that
 * run before `app.workspace_ids` is known: resolving which
 * workspaces a user can access, and validating workspace
 * existence. Never pass this to handlers.
 */
export const adminDb = env.DATABASE_APP_URL
  ? drizzle(env.DATABASE_URL, {
      relations: { ...relations, ...authRelationsPart },
      schema: {
        propertyStatusEnum,
        timeEntryStatusEnum,
        timeEntrySourceEnum,
        invoiceStatusEnum,
      },
    })
  : db;

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Scoped database handle that wraps every operation in a
 * short-lived RLS transaction. Each call to `scopedDb(fn)`
 * opens a transaction, sets `app.workspace_ids` via
 * SET LOCAL, runs `fn`, and commits. The connection returns
 * to the pool immediately after — safe with PgBouncer in
 * transaction mode and streaming-friendly.
 *
 * Handlers receive this from `authMacro` and must never
 * import `db` directly (enforced by Biome lint rule).
 */
export type ScopedDb = {
  <T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  readonly workspaceIds: readonly string[];
};

export const createScopedDb = (workspaceIds: string[]): ScopedDb => {
  const ids = workspaceIds.join(",");
  const frozen = Object.freeze(workspaceIds);

  const call = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config(
          'app.workspace_ids', ${ids}, true
        )`,
      );
      return fn(tx);
    });

  return Object.assign(call, {
    workspaceIds: frozen,
  } as const);
};
