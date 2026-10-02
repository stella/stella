import { test } from "bun:test";

import { defaultConfig } from "@stll/db-load-gate/health";

import { withGatedTestClients } from "../tests/gated-test-database";
import { createOnlineIndexGate } from "./online-index-gate";
import type { OnlineMigrationConnection } from "./online-migration-connection";

test.skipIf(process.env["ONLINE_INDEX_TEST_TABLE"] === undefined)(
  "isolated online-index runner process",
  async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    const table = process.env["ONLINE_INDEX_TEST_TABLE"];
    const name = process.env["ONLINE_INDEX_TEST_NAME"];
    const now = Number(process.env["ONLINE_INDEX_TEST_NOW"]);
    if (!databaseUrl || !table || !name || !Number.isFinite(now)) {
      throw new TypeError(
        "Online index child fixture is missing its test configuration",
      );
    }
    await withGatedTestClients(
      databaseUrl,
      async ({ openClient }) => {
        const builder = await openClient().sql.reserve();
        const observer = await openClient().sql.reserve();
        const adapt = (
          connection: typeof builder,
        ): OnlineMigrationConnection => ({
          query: async (statement, parameters = []) =>
            await connection.unsafe<unknown[]>(statement, [...parameters]),
          execute: async (statement, parameters = []) => {
            await connection.unsafe(statement, [...parameters]);
          },
          release: () => connection.release(),
          terminate: async () => {
            await connection.close({ timeout: 0 });
          },
        });
        const rows = await builder<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const pid = rows.at(0)?.pid;
        if (pid === undefined) {
          throw new TypeError("Missing child backend pid");
        }
        process.stdout.write(`runner-pid:${String(pid)}\n`);
        const gate = createOnlineIndexGate({
          connection: adapt(builder),
          observer: adapt(observer),
          tableName: table,
          name,
          kind: "index_build",
          config: {
            health: {
              ...defaultConfig,
              busyWindows: [],
              longTxMaxAgeMs: 3_600_000,
            },
            pollMs: 1,
            retryMs: 1,
            maxSnapshotWaitMs: 600_000,
            clientConnectionCheckMs: 10,
            parallelWorkers: 1,
            maintenanceWorkMemMb: 16,
          },
          clock: () => now,
          ebs: {
            type: "reader",
            read: async () => ({
              indicator: "ebs_balance",
              kind: "normal",
              value: 100,
              threshold: 70,
              observedAt: new Date(now).toISOString(),
              reason: "injected child metric",
            }),
          },
          wait: async (_milliseconds, signal) => {
            if (!signal.aborted) {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            }
          },
          log: () => undefined,
        });
        try {
          await gate.attempt(
            `CREATE INDEX CONCURRENTLY ${name} ON public.${table} (id)`,
          );
        } finally {
          await gate.close();
          builder.release();
          observer.release();
        }
      },
      { closeTimeout: 0 },
    );
  },
);
