/**
 * The per-run summary both verification listings answer with: status, why it
 * failed, the list it checked against, and claim counts per verdict state.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { legalListClaims, legalListVerificationRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { CLAIM_STATE } from "@/api/lib/lists/verification/contract";
import type { ClaimState } from "@/api/lib/lists/verification/contract";

const stateFilterCount = (state: ClaimState): SQL<number> =>
  sql<number>`count(${legalListClaims.id}) filter (where ${legalListClaims.state} = ${state})::int`;

/** Total over the claim states, so a new state cannot go uncounted. */
export const CLAIM_COUNT_COLUMNS = {
  supported: stateFilterCount(CLAIM_STATE.SUPPORTED),
  tension: stateFilterCount(CLAIM_STATE.TENSION),
  contradicted: stateFilterCount(CLAIM_STATE.CONTRADICTED),
  nocover: stateFilterCount(CLAIM_STATE.NOCOVER),
  notverifiable: stateFilterCount(CLAIM_STATE.NOTVERIFIABLE),
  recordconflict: stateFilterCount(CLAIM_STATE.RECORDCONFLICT),
} as const satisfies Record<ClaimState, SQL<number>>;

/** The run columns a summary reads, beside the claim counts. */
export const RUN_SUMMARY_COLUMNS = {
  id: legalListVerificationRuns.id,
  entityId: legalListVerificationRuns.entityId,
  fileFieldId: legalListVerificationRuns.fileFieldId,
  status: legalListVerificationRuns.status,
  errorCode: legalListVerificationRuns.errorCode,
  entityVersionId: legalListVerificationRuns.entityVersionId,
  listId: sql<
    SafeId<"legalList">
  >`(${legalListVerificationRuns.evidence} ->> 'listId')`,
  createdAt: legalListVerificationRuns.createdAt,
  finishedAt: legalListVerificationRuns.finishedAt,
} as const;

type RunSummaryRow = {
  id: SafeId<"legalListVerificationRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  status: (typeof legalListVerificationRuns.$inferSelect)["status"];
  errorCode: (typeof legalListVerificationRuns.$inferSelect)["errorCode"];
  entityVersionId: SafeId<"entityVersion">;
  listId: SafeId<"legalList">;
  createdAt: Date;
  finishedAt: Date | null;
} & Record<ClaimState, number>;

export const serializeRunSummary = (run: RunSummaryRow) => ({
  id: run.id,
  entityId: run.entityId,
  fileFieldId: run.fileFieldId,
  status: run.status,
  errorCode: run.errorCode,
  entityVersionId: run.entityVersionId,
  listId: run.listId,
  createdAt: run.createdAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  claimCounts: {
    supported: run.supported,
    tension: run.tension,
    contradicted: run.contradicted,
    nocover: run.nocover,
    notverifiable: run.notverifiable,
    recordconflict: run.recordconflict,
  } satisfies Record<ClaimState, number>,
});
