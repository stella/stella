import { panic } from "better-result";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { systemAuditRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import { SYSTEM_RUN_ACTOR_COUNTS } from "./actors";
import type { SystemAuditCounts, SystemRunActor } from "./actors";

export type SystemAuditEvent<A extends SystemRunActor> = {
  /** The scheduler run, or the standalone script run, that made the change. */
  subject: SafeId<"schedulerJobRun"> | SafeId<"systemScriptRun">;
  counts: SystemAuditCounts<A>;
};

type SystemAuditRow = typeof systemAuditRuns.$inferInsert;

/**
 * The row one run records, or null when the run changed nothing. Counts must
 * be exactly the actor's declared keys, each a non-negative integer.
 */
export const systemAuditRow = <A extends SystemRunActor>(
  actor: A,
  { subject, counts }: SystemAuditEvent<A>,
): SystemAuditRow | null => {
  const declared: readonly string[] = SYSTEM_RUN_ACTOR_COUNTS[actor];
  const entries: [string, number][] = Object.entries(counts);
  if (
    entries.length !== declared.length ||
    entries.some(
      ([key, value]) =>
        !declared.includes(key) || !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    return panic(`${actor} counts must be its declared non-negative integers`);
  }
  if (entries.every(([, value]) => value === 0)) {
    return null;
  }
  return {
    id: Bun.randomUUIDv7(),
    actor,
    subject,
    counts: Object.fromEntries(entries),
  };
};

/**
 * Record what one system run changed: one `system_audit_runs` row per run,
 * with counts, and nothing when every count is zero. The require-audit-on-
 * mutation rule accepts a function that calls this, and every module that
 * `SYSTEM_AUDIT_MODULES` attributes to the actor.
 */
export const recordSystemAudit = async <A extends SystemRunActor>(
  db: Pick<PgAsyncDatabase<PgQueryResultHKT>, "insert">,
  actor: A,
  event: SystemAuditEvent<A>,
): Promise<boolean> => {
  const row = systemAuditRow(actor, event);
  if (row === null) {
    return false;
  }
  await db.insert(systemAuditRuns).values(row);
  return true;
};
