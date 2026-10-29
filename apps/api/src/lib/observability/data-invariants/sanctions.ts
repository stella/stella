import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { sanctionsContactScreenings } from "@/api/db/schema";
import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { SANCTIONS_SCREENING_STATUSES } from "@/api/lib/lists/sanctions/monitoring-vocabulary";
import {
  DATA_INVARIANT_ID,
  type DataInvariant,
  type DataInvariantFinding,
  type DataInvariantReadDb,
  judgeDataInvariant,
} from "@/api/lib/observability/data-invariants/invariant";

type ListReason = "not-loaded" | "access-denied" | "empty" | "stale";

const HOUR_MS = 60 * 60 * 1000;

const listFinding = (
  freshness: SanctionsSourceFreshness,
  now: Date,
): DataInvariantFinding<ListReason> | null => {
  const { edition, lastSuccessfulVerifiedAt, reason, source } = freshness;
  if (edition === null) {
    return {
      target: source,
      reason: reason === "access-denied" ? "access-denied" : "not-loaded",
      observed: null,
      expected: "an active edition",
    };
  }
  if (edition.entryCount === 0) {
    return {
      target: source,
      reason: "empty",
      observed: 0,
      expected: ">= 1 entry",
    };
  }
  switch (reason) {
    case null:
      return null;
    case "stale":
      return {
        target: source,
        reason: "stale",
        observed:
          lastSuccessfulVerifiedAt === null
            ? null
            : Math.floor(
                (now.getTime() - lastSuccessfulVerifiedAt.getTime()) / HOUR_MS,
              ),
        expected: "hours since verification within the list's limit",
      };
    // An edition that was never verified against its publisher.
    case "not-loaded":
    case "access-denied":
      return {
        target: source,
        reason,
        observed: null,
        expected: "a successful verification",
      };
    default:
      reason satisfies never;
      return panic(`Unhandled sanctions freshness reason: ${String(reason)}`);
  }
};

type SanctionsListsInvariantOptions = {
  /** Every configured list, including ones with no row yet. */
  readFreshness: (now: Date) => Promise<readonly SanctionsSourceFreshness[]>;
};

/**
 * Every configured list has a ready edition, holds entries, and was verified
 * against its publisher within its limit. A list that fails any of these
 * screens nothing while answering normally, so it is critical.
 */
export const sanctionsListsInvariant = ({
  readFreshness,
}: SanctionsListsInvariantOptions): DataInvariant<
  ListReason,
  typeof DATA_INVARIANT_ID.sanctionsListsLoaded
> => ({
  id: DATA_INVARIANT_ID.sanctionsListsLoaded,
  owner: "sanctions",
  severity: "critical",
  check: async ({ now }) => {
    const lists = await readFreshness(now);
    const findings: DataInvariantFinding<ListReason>[] = [];
    for (const list of lists) {
      const finding = listFinding(list, now);
      if (finding !== null) {
        findings.push(finding);
      }
    }
    return judgeDataInvariant(lists.length, findings);
  },
});

/**
 * The largest share of a list's current screenings that may be incomplete
 * (a bounded scan stopped part way through the list, so the subject was not
 * cleared). Common names legitimately exhaust the work budget now and then; a
 * share above this is a matcher or list regression, not a name.
 */
export const SANCTIONS_INCOMPLETE_SHARE_MAX = 0.05;

type StoredScreeningStatus = (typeof SANCTIONS_SCREENING_STATUSES)[number];

const INCOMPLETE = "incomplete" satisfies StoredScreeningStatus;
/** A contact opted out of monitoring: recorded, never screened. */
const EXCLUDED = "excluded" satisfies StoredScreeningStatus;

/**
 * Screenings per list and how many are incomplete, over each contact's latest
 * screening; excluded contacts are not screenings and are left out. Counts
 * only, so no tenant data leaves the aggregate.
 *
 * Unindexed by design: the table holds one row per monitored contact and
 * list, and this scheduler-only read runs hourly, never on a request. Bound:
 * one sequential scan of that table per run. Replace it with a
 * `(source_id, status)` index once the scan shows in the run's duration.
 */
const readScreeningCounts = async (db: DataInvariantReadDb) =>
  await db(
    async (tx) =>
      await tx
        .select({
          sourceId: sanctionsContactScreenings.sourceId,
          screenings:
            sql<number>`(count(*) FILTER (WHERE ${sanctionsContactScreenings.status} <> ${EXCLUDED}))::integer`.mapWith(
              Number,
            ),
          incomplete:
            sql<number>`(count(*) FILTER (WHERE ${sanctionsContactScreenings.status} = ${INCOMPLETE}))::integer`.mapWith(
              Number,
            ),
        })
        .from(sanctionsContactScreenings)
        .groupBy(sanctionsContactScreenings.sourceId),
  );

type CompletenessReason = "incomplete-share";

/**
 * Per list, the share of incomplete screenings stays at or below
 * `SANCTIONS_INCOMPLETE_SHARE_MAX`. A truncated screening is stored as
 * `incomplete` and is not a clearance, so a list whose screenings mostly
 * stop part way answers as if it had screened while proving nothing.
 */
export const sanctionsScreeningCompletenessInvariant = ({
  db,
}: {
  db: DataInvariantReadDb;
}): DataInvariant<
  CompletenessReason,
  typeof DATA_INVARIANT_ID.sanctionsScreeningCompleteness
> => ({
  id: DATA_INVARIANT_ID.sanctionsScreeningCompleteness,
  owner: "sanctions",
  severity: "critical",
  check: async () => {
    const counts = await readScreeningCounts(db);
    const findings: DataInvariantFinding<CompletenessReason>[] = [];
    for (const { sourceId, screenings, incomplete } of counts) {
      const share = screenings === 0 ? 0 : incomplete / screenings;
      if (share > SANCTIONS_INCOMPLETE_SHARE_MAX) {
        findings.push({
          target: sourceId,
          reason: "incomplete-share",
          observed: share,
          expected: `<= ${SANCTIONS_INCOMPLETE_SHARE_MAX}`,
        });
      }
    }
    return judgeDataInvariant(counts.length, findings);
  },
});
