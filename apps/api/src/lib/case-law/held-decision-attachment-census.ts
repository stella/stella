import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Subquery } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawHeldDecisionAttachments,
  caseLawSources,
} from "@/api/db/schema";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import {
  HELD_DECISION_ATTACHMENTS,
  type HeldDecisionAttachment,
} from "@/api/lib/legal-search/held-decision-attachment";
import { HELD_DECISION_ATTACHMENT_STATUS } from "@/api/lib/legal-search/held-decision-attachment-values";

/** Rows each finding lists at most; the counts are exact. */
export const HELD_DECISION_ATTACHMENT_CENSUS_SAMPLE = 20;

export type HeldDecisionAttachmentCensus = {
  adapterKey: string;
  /**
   * Attached records whose host decision is gone or redacted: an erasure or
   * a merge that did not park them. Should be 0.
   */
  hostVanished: {
    count: number;
    sample: { sourceDocumentId: string; hostDecisionId: string }[];
  };
  /**
   * Decisions of the attaching source stored as rows of their own whose ECLI
   * a host decision also carries: a duplicate the attach step exists to
   * prevent, typically from a record written before its host arrived. Should
   * be 0.
   */
  ownRowsMatchingHost: {
    count: number;
    sample: { decisionId: string; hostDecisionId: string }[];
  };
  /** Records parked because several held decisions matched. */
  ambiguous: number;
};

const countRows = async (tx: Transaction, rows: Subquery): Promise<number> =>
  (await tx.select({ count: sql<number>`count(*)::int` }).from(rows)).at(0)
    ?.count ?? 0;

type Declared = readonly [string, HeldDecisionAttachment<string>];

const declaredAttachments = (): Declared[] =>
  Object.entries(HELD_DECISION_ATTACHMENTS).map(
    ([key, declaration]) => [key, declaration] as const,
  );

/**
 * The projection census of held-decision attachments, per declaring source:
 * what the attach step's invariants say must be empty, compared against the
 * decision rows themselves. Read-only; the runbook reads it with
 * `src/scripts/case-law-held-attachment-census.ts`.
 */
export const readHeldDecisionAttachmentCensus = async (
  tx: Transaction,
  declarations: readonly Declared[] = declaredAttachments(),
): Promise<HeldDecisionAttachmentCensus[]> => {
  const census: HeldDecisionAttachmentCensus[] = [];
  for (const [adapterKey, declaration] of declarations) {
    const sourceIds = tx
      .select({ id: caseLawSources.id })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, adapterKey));
    const hostSourceIds = tx
      .select({ id: caseLawSources.id })
      .from(caseLawSources)
      .where(
        and(
          inArray(caseLawSources.adapterKey, [...declaration.hostAdapterKeys]),
          ne(caseLawSources.adapterKey, adapterKey),
        ),
      );

    const host = alias(caseLawDecisions, "census_attachment_host");
    const vanished = and(
      inArray(caseLawHeldDecisionAttachments.sourceId, sourceIds),
      eq(
        caseLawHeldDecisionAttachments.status,
        HELD_DECISION_ATTACHMENT_STATUS.ATTACHED,
      ),
      or(isNull(host.id), sql`${host.redactedAt} IS NOT NULL`),
    );
    const vanishedFrom = () =>
      tx
        .select({
          sourceDocumentId: caseLawHeldDecisionAttachments.sourceDocumentId,
          hostDecisionId: sql<string>`${caseLawHeldDecisionAttachments.hostDecisionId}::text`,
        })
        .from(caseLawHeldDecisionAttachments)
        .leftJoin(
          host,
          eq(
            host.id,
            canonicalDecisionIdSql(
              caseLawHeldDecisionAttachments.hostDecisionId,
            ),
          ),
        )
        .where(vanished);
    // db-await-in-loop: one bounded census per declaring source
    const vanishedCount = await countRows(tx, vanishedFrom().as("vanished"));
    // db-await-in-loop: one bounded census per declaring source
    const vanishedSample = await vanishedFrom()
      .orderBy(caseLawHeldDecisionAttachments.sourceDocumentId)
      .limit(HELD_DECISION_ATTACHMENT_CENSUS_SAMPLE);

    const ownEcli = alias(caseLawDecisionIdentifiers, "census_own_ecli");
    const hostEcli = alias(caseLawDecisionIdentifiers, "census_host_ecli");
    const hostRow = alias(caseLawDecisions, "census_host_row");
    const duplicatesFrom = () =>
      tx
        .selectDistinct({
          decisionId: sql<string>`${caseLawDecisions.id}::text`,
          hostDecisionId: sql<string>`${hostRow.id}::text`,
        })
        .from(caseLawDecisions)
        .innerJoin(
          ownEcli,
          and(
            eq(ownEcli.decisionId, caseLawDecisions.id),
            eq(ownEcli.type, DECISION_IDENTIFIER_TYPES.ECLI),
          ),
        )
        .innerJoin(
          hostEcli,
          and(
            eq(hostEcli.type, DECISION_IDENTIFIER_TYPES.ECLI),
            eq(hostEcli.normalizedValue, ownEcli.normalizedValue),
            ne(hostEcli.decisionId, caseLawDecisions.id),
          ),
        )
        .innerJoin(
          hostRow,
          and(
            eq(hostRow.id, hostEcli.decisionId),
            inArray(hostRow.sourceId, hostSourceIds),
          ),
        )
        .where(
          and(
            inArray(caseLawDecisions.sourceId, sourceIds),
            isNull(caseLawDecisions.redactedAt),
          ),
        );
    // db-await-in-loop: one bounded census per declaring source
    const duplicateCount = await countRows(
      tx,
      duplicatesFrom().as("duplicates"),
    );
    // db-await-in-loop: one bounded census per declaring source
    const duplicateSample = await duplicatesFrom()
      .orderBy(sql`1`)
      .limit(HELD_DECISION_ATTACHMENT_CENSUS_SAMPLE);

    // db-await-in-loop: one bounded census per declaring source
    const ambiguous = await tx.$count(
      caseLawHeldDecisionAttachments,
      and(
        inArray(caseLawHeldDecisionAttachments.sourceId, sourceIds),
        eq(
          caseLawHeldDecisionAttachments.status,
          HELD_DECISION_ATTACHMENT_STATUS.AMBIGUOUS,
        ),
      ),
    );
    census.push({
      adapterKey,
      hostVanished: { count: vanishedCount, sample: vanishedSample },
      ownRowsMatchingHost: {
        count: duplicateCount,
        sample: duplicateSample,
      },
      ambiguous,
    });
  }
  return census;
};
