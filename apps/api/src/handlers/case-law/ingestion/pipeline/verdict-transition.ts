import { and, eq, isNull, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { timestampMatchesCasToken } from "@/api/lib/db/timestamp-cas";
import { ORACLE_VERSION } from "@/api/lib/legal-search/text-retention/types";
import {
  EXCLUSION_VERSION,
  retentionCompositionFingerprint,
} from "@/api/lib/legal-search/text-retention/validation";
import {
  readRetentionVerdictTx,
  writeRetentionVerdictTx,
} from "@/api/lib/legal-search/text-retention/verdict-storage";

import type { SourceRawArtifact } from "./decision-raw";
import type { assessStoredDecision } from "./text-validation";

/** Only an exact, noncomposite retained envelope can reuse a successful certificate. */
export const hasCurrentRetentionVerdict = async (
  scopedDb: ScopedDb,
  decisionId: SafeId<"caseLawDecision">,
  rawArtifact: SourceRawArtifact,
) => {
  const prepared = rawArtifact.preparedRaw;
  if (prepared === null) {
    return false;
  }
  const rawFingerprint = new Bun.CryptoHasher("sha256")
    .update(prepared.payload)
    .digest("hex");
  return await scopedDb(async (tx) => {
    const verdict = await readRetentionVerdictTx(tx, decisionId);
    if (
      verdict === null ||
      verdict.status === "unavailable" ||
      verdict.components.length > 0
    ) {
      return false;
    }
    const row = (
      await tx
        .select({
          sourceId: caseLawDecisions.sourceId,
          sourceHash: caseLawDecisions.sourceHash,
          rawS3Key: caseLawDecisions.sourceRawS3Key,
          contentHash: caseLawDecisions.contentHash,
          parserVersion: caseLawDecisions.parserVersion,
          redactedAt: caseLawDecisions.redactedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1)
    ).at(0);
    return (
      row !== undefined &&
      row.redactedAt === null &&
      row.contentHash !== null &&
      verdict.sourceId === row.sourceId &&
      verdict.sourceHash === row.sourceHash &&
      verdict.rawS3Key === row.rawS3Key &&
      prepared.key === row.rawS3Key &&
      verdict.rawFingerprint === rawFingerprint &&
      verdict.payloadFingerprint === row.contentHash &&
      verdict.parserVersion === row.parserVersion &&
      verdict.oracleVersion === ORACLE_VERSION &&
      verdict.exclusionVersion === EXCLUSION_VERSION &&
      verdict.compositionFingerprint ===
        retentionCompositionFingerprint({
          rawFingerprint,
          payloadFingerprint: row.contentHash,
          components: [],
        })
    );
  });
};

type TransitionOptions = {
  scopedDb: ScopedDb;
  decisionId: SafeId<"caseLawDecision">;
  assessed: Awaited<ReturnType<typeof assessStoredDecision>>;
};

/** Lock the identical snapshot; a lost CAS leaves the winner's document and verdict untouched. */
export const certifyUnchangedDecision = async ({
  scopedDb,
  decisionId,
  assessed,
}: TransitionOptions) => {
  const { snapshot, assessment } = assessed;
  if (snapshot === null) {
    return false;
  }
  const { row } = snapshot;
  return await scopedDb(async (tx) => {
    const matches = await tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.id, decisionId),
          eq(caseLawDecisions.sourceId, row.sourceId),
          isNull(caseLawDecisions.redactedAt),
          timestampMatchesCasToken(
            caseLawDecisions.updatedAt,
            row.updatedAtToken,
          ),
          sql`${caseLawDecisions.sourceObservationOrder} IS NOT DISTINCT FROM ${row.sourceObservationOrder}`,
          sql`${caseLawDecisions.sourceHash} IS NOT DISTINCT FROM ${row.sourceHash}`,
          sql`${caseLawDecisions.sourceRawS3Key} IS NOT DISTINCT FROM ${row.sourceRawS3Key}`,
          sql`${caseLawDecisions.sourceRawContentType} IS NOT DISTINCT FROM ${row.sourceRawContentType}`,
          sql`${caseLawDecisions.contentHash} IS NOT DISTINCT FROM ${row.contentHash}`,
          sql`${caseLawDecisions.parserVersion} IS NOT DISTINCT FROM ${row.parserVersion}`,
          sql`${caseLawDecisions.fulltext} IS NOT DISTINCT FROM ${row.text}`,
          sql`${caseLawDecisions.documentAst} IS NOT DISTINCT FROM ${row.ast === null ? null : JSON.stringify(row.ast)}::text::jsonb`,
          sql`${caseLawDecisions.sections} IS NOT DISTINCT FROM ${row.sections === null ? null : JSON.stringify(row.sections)}::text::jsonb`,
          sql`${caseLawDecisions.textS3Key} IS NOT DISTINCT FROM ${row.textS3Key}`,
          sql`${caseLawDecisions.astS3Key} IS NOT DISTINCT FROM ${row.astS3Key}`,
          sql`${caseLawDecisions.normalizedS3Key} IS NOT DISTINCT FROM ${row.normalizedS3Key}`,
        ),
      )
      .for("update")
      .limit(1);
    if (matches.length === 0) {
      return false;
    }
    await writeRetentionVerdictTx(tx, {
      decisionId,
      sourceId: row.sourceId,
      sourceHash: row.sourceHash,
      rawS3Key: row.sourceRawS3Key,
      assessment,
    });
    return true;
  });
};
