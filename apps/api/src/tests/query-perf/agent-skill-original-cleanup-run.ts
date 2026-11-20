import { Result, UnhandledException } from "better-result";
import { sql } from "drizzle-orm";

import { agentSkillOriginalCleanupRequests } from "@/api/db/schema";
import { createCleanAgentSkillOriginalObjects } from "@/api/lib/scheduler/tasks/agent-skill-original-cleanup";
import type { GatedTestClientScope } from "@/api/tests/gated-test-database";

import { measureScheduledTaskReplay } from "./scheduled-task-replay";
import { QUERY_PERF_CONNECTION_SETTINGS } from "./settings";

/** The run's batch: every due request, the ones whose key ends in 0 failing. */
const DUE_REQUESTS = 32;

const fixtureRun = createCleanAgentSkillOriginalObjects(
  async (keys) =>
    await Promise.resolve(
      keys.some((key) => key.endsWith("0"))
        ? Result.err(
            new UnhandledException({ cause: "fixture storage failure" }),
          )
        : Result.ok(),
    ),
);

/**
 * The fixed due batch beside `history` requests that are not yet due, so a
 * claim that scanned the table would have to cross them.
 */
export const measureAgentSkillOriginalCleanupHistory = async (
  openClient: GatedTestClientScope["openClient"],
) => {
  const { db } = openClient({ connection: QUERY_PERF_CONNECTION_SETTINGS });
  const now = new Date("2026-11-19T00:00:00Z");
  const measurements = [];
  for (const history of [1000, 10_000]) {
    // db-await-in-loop: isolated measurement scenarios run sequentially, each reseeding its own disposable fixture table.
    await db.delete(agentSkillOriginalCleanupRequests).where(sql`true`);
    // db-await-in-loop: seed the not-yet-due history before the due batch so a table scan has to cross it.
    await db.execute(sql`INSERT INTO agent_skill_original_cleanup_requests (organization_id, s3_keys, next_attempt_at)
      SELECT 'org_fixture', ARRAY['org_fixture/agent-skills/originals/history-' || n], now() + interval '1 hour' FROM generate_series(1, ${history}::integer) n`);
    // db-await-in-loop: the same due batch is present at both history sizes.
    await db.execute(sql`INSERT INTO agent_skill_original_cleanup_requests (organization_id, s3_keys, attempts, next_attempt_at)
      SELECT 'org_fixture', ARRAY['org_fixture/agent-skills/originals/due-' || n], 4, now() - interval '1 minute' FROM generate_series(1, ${DUE_REQUESTS}::integer) n`);
    // db-await-in-loop: each scenario gets current statistics before the task is captured and replayed.
    await db.execute(sql`ANALYZE agent_skill_original_cleanup_requests`);
    // db-await-in-loop: one measured task run per independently seeded history size.
    measurements.push({
      history,
      ...(await measureScheduledTaskReplay({
        openClient,
        label: "agent skill original cleanup",
        task: fixtureRun,
        now,
      })),
    });
  }
  return measurements;
};
