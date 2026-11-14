import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { OnlineMigrationConnection } from "../db/online-migration-connection";
import { withChatContentV3MigrationLock } from "./backfill-chat-content-v3-lock";

test("a terminated repair session preserves the original failure", async () => {
  const statements: string[] = [];
  const failure = new Error("observer failed");
  const connection: OnlineMigrationConnection = {
    execute: async (query) => {
      statements.push(query);
      if (query.includes("pg_advisory_unlock")) {
        throw new Error("connection closed");
      }
    },
    query: async (query) => {
      statements.push(query);
      return [{ acquired: true }];
    },
    release: () => undefined,
    terminate: async () => undefined,
  };

  const result = await rejectionOf(
    withChatContentV3MigrationLock(connection, async () => {
      await connection.terminate?.();
      throw failure;
    }),
  );

  expect(result).toBe(failure);
  expect(statements).toHaveLength(1);
  expect(statements.at(0)).toContain("pg_try_advisory_lock");
});
