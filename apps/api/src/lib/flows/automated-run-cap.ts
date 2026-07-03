import { and, eq, gte, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { flowRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * Count today's automated (schedule / file-upload) runs for a definition, used
 * by the automated triggers to enforce
 * `MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY`. "Today" is the current UTC
 * calendar day; manual runs are excluded via the `triggerSource` discriminator.
 *
 * Background path: reads through `rootDb` (like `processExtraction` and the
 * scheduler tasks), filtering explicitly by `definitionId` so the count is
 * scoped to a single definition regardless of tenant RLS session state.
 */
export const AUTOMATED_TRIGGER_SOURCE_TYPES = [
  "schedule",
  "file-upload",
] as const;

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export const countTodaysAutomatedFlowRuns = async (
  definitionId: SafeId<"flowDefinition">,
  now: Date = new Date(),
): Promise<number> =>
  rootDb.$count(
    flowRuns,
    and(
      eq(flowRuns.definitionId, definitionId),
      gte(flowRuns.createdAt, startOfUtcDay(now)),
      sql`${flowRuns.triggerSource}->>'type' in ('schedule', 'file-upload')`,
    ),
  );
