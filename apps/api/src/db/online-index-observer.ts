import { panic, Result } from "better-result";
import { SQL } from "bun";

import { resolveDatabaseUrl } from "../db-url";
import { readOnlineIndexConfig } from "../env-online-index";
import type { OnlineMigrationConnection } from "./online-migration-connection";

/** Private pool so a migrator retaining its sole session cannot deadlock monitoring. */
export const openOnlineIndexObserver =
  async (): Promise<OnlineMigrationConnection> => {
    const url = resolveDatabaseUrl();
    if (!url) {
      return panic("Online index observer requires a database connection");
    }
    const config = readOnlineIndexConfig();
    const client = new SQL({
      url,
      max: 1,
      idleTimeout: 0,
      connectionTimeout: config.health.readTimeoutMs / 1000,
      connection: {
        statement_timeout: config.health.readTimeoutMs,
        lock_timeout: config.health.readTimeoutMs,
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
