import { panic, Result } from "better-result";

import { createSqlClient } from "@/api/db/sql-client";

import { readOnlineIndexConfig } from "../env-online-index";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { terminateReserved } from "./sql-close";

type BoundedDatabaseObserverOptions = {
  url: string;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  applicationName?: string;
};

/** A dedicated session keeps bounded inspection independent of application pools. */
export const openBoundedDatabaseObserver = async ({
  url,
  statementTimeoutMs,
  lockTimeoutMs,
  applicationName,
}: BoundedDatabaseObserverOptions): Promise<OnlineMigrationConnection> => {
  for (const budget of [statementTimeoutMs, lockTimeoutMs]) {
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      panic("Database observer timeouts must be positive integer milliseconds");
    }
  }
  const client = createSqlClient({
    url,
    max: 1,
    idleTimeout: 0,
    connectionTimeout: statementTimeoutMs / 1000,
    connection: {
      statement_timeout: statementTimeoutMs,
      lock_timeout: lockTimeoutMs,
      ...(applicationName === undefined
        ? {}
        : { application_name: applicationName }),
    },
  });
  const reservation = await Result.tryPromise(
    async () => await client.reserve(),
  );
  if (reservation.isErr()) {
    await client.close();
    throw reservation.error;
  }
  const reserved = reservation.value;
  return {
    execute: async (query, params = []) => {
      await reserved.unsafe(query, [...params]);
    },
    query: async (query, params = []) =>
      await reserved.unsafe(query, [...params]),
    release: async () => {
      await reserved.release();
      await client.close();
    },
  };
};

/**
 * Private pool so a migrator retaining its sole session cannot deadlock
 * monitoring. `url` must name the migrator's database: the gate rejects an
 * observer in any other.
 */
export const openOnlineIndexObserver = async (
  url: string,
): Promise<OnlineMigrationConnection> => {
  const config = readOnlineIndexConfig();
  return await openBoundedDatabaseObserver({
    url,
    statementTimeoutMs: config.health.readTimeoutMs,
    lockTimeoutMs: config.health.readTimeoutMs,
  });
};

/**
 * One dedicated session for an operator-run online repair, outside the
 * migrator. It carries no session budgets: each repair batch installs its own
 * LOCAL budgets, and the online-migration lock must wait for a deploy's repair
 * rather than time out.
 */
export const openOnlineRepairConnection = async (
  url: string,
): Promise<OnlineMigrationConnection> => {
  const client = createSqlClient({ url, max: 1 });
  const reservation = await Result.tryPromise(
    async () => await client.reserve(),
  );
  if (reservation.isErr()) {
    await client.close();
    throw reservation.error;
  }
  const reserved = reservation.value;
  let session: "open" | "terminated" = "open";
  return {
    execute: async (query, params = []) => {
      await reserved.unsafe(query, [...params]);
    },
    query: async (query, params = []) =>
      await reserved.unsafe<unknown[]>(query, [...params]),
    release: async () => {
      if (session === "open") {
        await reserved.release();
      }
      await client.close();
    },
    // The table gate closes a session whose stalled statement it could not
    // cancel; the repair then fails rather than hold the table.
    terminate: async () => {
      session = "terminated";
      await terminateReserved(reserved);
    },
  };
};
