import { panic, Result } from "better-result";
import { SQL } from "bun";

import { readOnlineIndexConfig } from "../env-online-index";
import type { OnlineMigrationConnection } from "./online-migration-connection";

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
  const client = new SQL({
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
      reserved.release();
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
