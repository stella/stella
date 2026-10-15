import { isNull, lte, or } from "drizzle-orm";

import { documentProcessingRuns } from "@/api/db/schema";

/**
 * A pending scan is due unless an exhausted action period skipped it until a
 * later time. Dispatch and claim share this predicate, so a skipped scan is
 * neither enqueued nor run before its period ends.
 */
export const deadlineScoutDue = (now: Date) =>
  or(
    isNull(documentProcessingRuns.deadlineScoutSkippedUntil),
    lte(documentProcessingRuns.deadlineScoutSkippedUntil, now),
  );
