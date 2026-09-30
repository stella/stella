import { panic } from "better-result";
import { eq } from "drizzle-orm";

import {
  caseLawTextRetentionVerdicts,
  TEXT_RETENTION_STATUSES,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { ORACLE_VERSION } from "@/api/lib/legal-search/text-retention/types";
import { EXCLUSION_VERSION } from "@/api/lib/legal-search/text-retention/validation";

/** Public projection excludes raw addresses, source digests and component details. */
const textRetentionSummaryQuery = (
  tx: CaseLawPublicReadTransaction,
  decisionId: SafeId<"caseLawDecision">,
) =>
  tx
    .select({
      decisionId: caseLawTextRetentionVerdicts.decisionId,
      payloadFingerprint: caseLawTextRetentionVerdicts.payloadFingerprint,
      parserVersion: caseLawTextRetentionVerdicts.parserVersion,
      oracleVersion: caseLawTextRetentionVerdicts.oracleVersion,
      exclusionVersion: caseLawTextRetentionVerdicts.exclusionVersion,
      checkedAt: caseLawTextRetentionVerdicts.checkedAt,
      status: caseLawTextRetentionVerdicts.status,
      retainedRatio: caseLawTextRetentionVerdicts.retainedRatio,
      defect: caseLawTextRetentionVerdicts.defect,
      reason: caseLawTextRetentionVerdicts.reason,
    })
    .from(caseLawTextRetentionVerdicts)
    .where(eq(caseLawTextRetentionVerdicts.decisionId, decisionId))
    .limit(1);

type SummaryRecord = Awaited<
  ReturnType<typeof textRetentionSummaryQuery>
>[number];
export const readPublicTextRetentionRecord = async (
  tx: CaseLawPublicReadTransaction,
  decisionId: SafeId<"caseLawDecision">,
) => (await textRetentionSummaryQuery(tx, decisionId)).at(0);

type PublicTextRetentionOptions = {
  record: SummaryRecord | undefined;
  current: {
    contentHash: string | null;
    parserVersion: number | null;
    redactedAt: Date | null;
    payloadState: "available" | "unavailable" | "transient";
  };
};

/** A recorded pass only describes the payload and versions it actually checked. */
export const publicTextRetentionSummary = ({
  record,
  current,
}: PublicTextRetentionOptions) => {
  const unknown = {
    retainedRatio: null,
    defect: null,
    checkedAt: null,
    parserVersion: null,
    oracleVersion: null,
    exclusionVersion: null,
  };
  if (current.redactedAt !== null) {
    return {
      ...unknown,
      status: TEXT_RETENTION_STATUSES.unavailable,
      reason: "redacted",
    } as const;
  }
  if (current.payloadState === "transient") {
    return {
      ...unknown,
      status: TEXT_RETENTION_STATUSES.unavailable,
      reason: "transient_payload",
    } as const;
  }
  if (record === undefined) {
    return { ...unknown, status: "missing", reason: "not_checked" } as const;
  }
  const versions = {
    checkedAt: record.checkedAt,
    parserVersion: record.parserVersion,
    oracleVersion: record.oracleVersion,
    exclusionVersion: record.exclusionVersion,
  };
  if (current.contentHash === null || current.payloadState === "unavailable") {
    return {
      ...versions,
      status: TEXT_RETENTION_STATUSES.unavailable,
      retainedRatio: null,
      defect: null,
      reason: "payload_unavailable",
    } as const;
  }
  if (
    record.payloadFingerprint !== current.contentHash ||
    record.parserVersion !== current.parserVersion ||
    record.oracleVersion !== ORACLE_VERSION ||
    record.exclusionVersion !== EXCLUSION_VERSION
  ) {
    return {
      ...versions,
      status: TEXT_RETENTION_STATUSES.unavailable,
      retainedRatio: null,
      defect: null,
      reason: "stale_verdict",
    } as const;
  }
  switch (record.status) {
    case TEXT_RETENTION_STATUSES.assessed:
      if (record.retainedRatio === null) {
        return panic("An assessed text-retention verdict must record a ratio");
      }
      return {
        ...versions,
        status: record.status,
        retainedRatio: record.retainedRatio,
        defect: record.defect,
        reason: null,
      } as const;
    case TEXT_RETENTION_STATUSES.empty_source:
      return {
        ...versions,
        status: record.status,
        retainedRatio: null,
        defect: null,
        reason: null,
      } as const;
    case TEXT_RETENTION_STATUSES.unavailable:
      if (record.reason === null) {
        return panic(
          "An unavailable text-retention verdict must record a reason",
        );
      }
      return {
        ...versions,
        status: record.status,
        retainedRatio: null,
        defect: null,
        reason: record.reason,
      } as const;
    default:
      record.status satisfies never;
      return panic("Unhandled public text-retention status");
  }
};
