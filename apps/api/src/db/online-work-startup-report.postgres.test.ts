import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { withGatedTestClients } from "../tests/gated-test-database";
import { ONLINE_WORK_NAMES } from "./online-migrations";
import { PENDING } from "./online-work-lifecycle";
import { readOnlineWorkStartupReport } from "./online-work-startup-report";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(!enabled)("online work startup checkpoint census", () => {
  test("reads durable progress without waiting for the online lock", async () => {
    if (databaseUrl === undefined) {
      panic("DATABASE_URL is required");
    }
    const name = ONLINE_WORK_NAMES.at(0) ?? panic("Expected an online unit");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const builder = openClient().sql;
      const reader = await openClient().sql.reserve();
      await builder.unsafe(
        "SELECT pg_advisory_lock(hashtext('stella-online-migrations'))",
      );
      try {
        await reader.unsafe("BEGIN");
        await reader.unsafe("SET LOCAL statement_timeout = '2s'");
        await reader.unsafe(
          `INSERT INTO public.online_work_state (name, state) VALUES ($1, 'running')
           ON CONFLICT (name) DO UPDATE SET state = 'running'`,
          [name],
        );
        const report = await readOnlineWorkStartupReport(
          {
            query: async (query, params = []) =>
              await reader.unsafe(query, [...params]),
          },
          { names: [name], lifecycle: { [name]: PENDING } },
        );
        expect(report).toEqual({
          units: [{ name, lifecycle: "pending", state: "running" }],
          pending: 1,
        });
        expect(
          await reader.unsafe(
            "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
          ),
        ).toEqual([{ held: 0 }]);
      } finally {
        await reader.unsafe("ROLLBACK");
        await reader.release();
        await builder.unsafe(
          "SELECT pg_advisory_unlock(hashtext('stella-online-migrations'))",
        );
      }
    });
  });
});
