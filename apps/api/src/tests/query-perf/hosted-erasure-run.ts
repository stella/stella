import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { hostedCustomerErasures } from "@/api/db/schema";
import { HostedUsageProviderApiError } from "@/api/lib/hosted-usage-provider/client";
import { createSchedulerTaskRegistry } from "@/api/lib/scheduler/registry";
import { ERASE_HOSTED_CUSTOMERS_TASK } from "@/api/lib/scheduler/tasks/hosted-customer-erasure";
import type { GatedTestClientScope } from "@/api/tests/gated-test-database";

import { measureScheduledTaskReplay } from "./scheduled-task-replay";
import { QUERY_PERF_CONNECTION_SETTINGS } from "./settings";

const noopTask = () => undefined;

/** Replay the registered writing task's statements in order, then roll back. */
const measureHostedErasureRun = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const now = new Date("2026-10-29T00:00:00Z");
  const task =
    createSchedulerTaskRegistry(noopTask, noopTask, {
      hostedCustomerErasureDependencies: {
        credentials: { apiKey: "fixture", baseUrl: "https://provider.test" },
        provider: "polar",
        erase: async ({ externalCustomerRef }) =>
          await Promise.resolve(
            externalCustomerRef.endsWith("0")
              ? Result.err(
                  new HostedUsageProviderApiError({
                    message: "Fixture refusal",
                    status: 503,
                  }),
                )
              : Result.ok(undefined),
          ),
        observe: noopTask,
        now: () => now,
      },
    }).get(ERASE_HOSTED_CUSTOMERS_TASK) ??
    panic("Erasure task is unregistered");
  return await measureScheduledTaskReplay({
    openClient,
    label: "erasure",
    task,
    now,
  });
};

/** Fixed 25-row work batch, with retained terminal history at two sizes. */
export const measureHostedErasureHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  const measurements = [];
  for (const history of [1000, 10_000]) {
    // db-await-in-loop: isolated measurement scenarios run sequentially, each reseeding its own disposable fixture table.
    await db.delete(hostedCustomerErasures).where(sql`true`);
    // db-await-in-loop: seed the terminal history before the fixed eligible batch so a table scan has to cross the history.
    await db.execute(sql`INSERT INTO hosted_customer_erasures (external_customer_ref, status, attempts, next_attempt_at)
      SELECT 'history_' || n, 'failed', 5, '2020-01-01'::timestamptz FROM generate_series(1, ${history}::integer) n`);
    // db-await-in-loop: the same eligible batch is present at both history sizes.
    await db.execute(sql`INSERT INTO hosted_customer_erasures (external_customer_ref, status, attempts, next_attempt_at)
      SELECT 'due_' || n, 'pending', 4, '2020-01-01'::timestamptz FROM generate_series(1, 25) n`);
    // db-await-in-loop: each scenario gets current statistics before the actual task is captured and replayed.
    await db.execute(sql`ANALYZE hosted_customer_erasures`);
    // db-await-in-loop: one measured task run per independently seeded history size.
    measurements.push({
      history,
      ...(await measureHostedErasureRun(openClient)),
    });
  }
  return measurements;
};
