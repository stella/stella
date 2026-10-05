import { panic } from "better-result";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";
import * as v from "valibot";

import { PROVISION_LINK_STATUS_TYPES } from "@stll/api-contract/provision-link-status";
import type { ProvisionLinkStatus } from "@stll/api-contract/provision-link-status";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawProvisionExtractions,
  caseLawProvisionExtractionRevisions,
  caseLawProvisionExtractionRevisionsRegistry,
} from "@/api/db/schema";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

import {
  PROVISION_VERSION_COLUMNS,
  projectProvisionVersion,
} from "./version-response";

export const listDecisionProvisionsQuerySchema = t.Object({
  limit: t.Optional(tPaginationLimit(LIMITS.caseLawSearchPageSizeMax)),
  cursor: t.Optional(tPaginationCursor()),
});

type ListDecisionProvisionsQuery = Static<
  typeof listDecisionProvisionsQuerySchema
>;

type ListDecisionProvisionsOptions = {
  /**
   * Gated upstream, and the only database handle this read gets: its rows
   * come from the transaction that approved it.
   */
  subject: RedistributableDecisionSubject;
  query: ListDecisionProvisionsQuery;
};

const POSTGRES_INTEGER_MAX = 2_147_483_647;

type ProvisionCursor = {
  generation: string;
  spanStart: number;
  anchor: string;
};

const decodeProvisionCursor = (cursor: string): ProvisionCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (parts?.length !== 3) {
    return null;
  }

  const [generation, spanStart, anchor] = parts;
  if (
    typeof generation !== "string" ||
    !/^(0|[1-9][0-9]*)$/u.test(generation) ||
    typeof spanStart !== "number" ||
    !Number.isSafeInteger(spanStart) ||
    spanStart < 0 ||
    spanStart > POSTGRES_INTEGER_MAX ||
    typeof anchor !== "string"
  ) {
    return null;
  }

  return { generation, spanStart, anchor };
};

const LEGACY_CITATION_FIELDS = {
  // Drizzle detects absent left-join rows from the first column; keep it non-null.
  jurisdiction: caseLawProvisionCitations.jurisdiction,
  workIdentifier: caseLawProvisionCitations.workIdentifier,
  workNumber: caseLawProvisionCitations.workNumber,
  workYear: caseLawProvisionCitations.workYear,
  workCollection: caseLawProvisionCitations.workCollection,
  workEli: caseLawProvisionCitations.workEli,
  workSource: caseLawProvisionCitations.workSource,
  unit: caseLawProvisionCitations.unit,
  section: caseLawProvisionCitations.section,
  sectionSuffix: caseLawProvisionCitations.sectionSuffix,
  subsection: caseLawProvisionCitations.subsection,
  letter: caseLawProvisionCitations.letter,
  point: caseLawProvisionCitations.point,
  sentence: caseLawProvisionCitations.sentence,
  openEnded: caseLawProvisionCitations.openEnded,
  anchor: caseLawProvisionCitations.anchor,
  versionValidFrom: caseLawProvisionCitations.versionValidFrom,
  sentenceText: caseLawProvisionCitations.sentenceText,
  spanStart: caseLawProvisionCitations.spanStart,
  spanEnd: caseLawProvisionCitations.spanEnd,
  confidence: caseLawProvisionCitations.confidence,
  ...PROVISION_VERSION_COLUMNS,
};

const SPAN_CITATION_FIELDS = {
  spanRole: caseLawProvisionCitations.spanRole,
  printPieceId: caseLawProvisionCitations.printPieceId,
  printStart: caseLawProvisionCitations.printStart,
  printEnd: caseLawProvisionCitations.printEnd,
  printText: caseLawProvisionCitations.printText,
  namePieceId: caseLawProvisionCitations.namePieceId,
  nameStart: caseLawProvisionCitations.nameStart,
  nameEnd: caseLawProvisionCitations.nameEnd,
  nameText: caseLawProvisionCitations.nameText,
  selection: caseLawProvisionCitations.selection,
  printedWorkIdentifier: caseLawProvisionCitations.printedWorkIdentifier,
  targetDocumentId: caseLawProvisionCitations.targetDocumentId,
  targetStatus: caseLawProvisionCitations.targetStatus,
};

const UNAVAILABLE_SPAN_FIELDS = {
  spanRole: null,
  printPieceId: null,
  printStart: null,
  printEnd: null,
  printText: null,
  namePieceId: null,
  nameStart: null,
  nameEnd: null,
  nameText: null,
  selection: null,
  printedWorkIdentifier: null,
  targetDocumentId: null,
  targetStatus: null,
} satisfies Record<keyof typeof SPAN_CITATION_FIELDS, null>;

type ProvisionRow = Pick<
  typeof caseLawProvisionCitations.$inferSelect,
  keyof typeof LEGACY_CITATION_FIELDS | keyof typeof SPAN_CITATION_FIELDS
>;

type ProvisionPageOptions = {
  rows: ProvisionRow[];
  limit: number;
  generation: string;
  status: ProvisionLinkStatus;
  publishedProjectionDigest: string | null;
};

const provisionPage = ({
  rows,
  limit,
  generation,
  status: linkStatus,
  publishedProjectionDigest,
}: ProvisionPageOptions) => ({
  ...createCursorPage({
    rows: rows.map(projectProvisionVersion),
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([generation, item.spanStart, item.anchor]),
  }),
  status: linkStatus,
  generation,
  publishedProjectionDigest,
});

/** Check on this transaction, so a grant rollout takes effect without a restart. */
const canReadProvisionStatus = async (tx: CaseLawPublicReadTransaction) => {
  const columns = publicLawColumnPairs(
    PROVISION_LINK_STATUS_COLUMN_GRANTS_BY_RELATION,
  );
  const [permissions] = await tx
    .select({
      available: sql<boolean>`
      has_function_privilege(current_user,
        'public.case_law_provision_extraction_in_scope(character varying,character varying)', 'EXECUTE')
      AND has_function_privilege(current_user,
        'public.case_law_provision_extraction_input_digest(text,date,text,text,boolean)', 'EXECUTE')
      AND ${sql.join(
        columns.map(
          ({ relation, column }) =>
            sql`has_column_privilege(current_user, ${`public.${relation}`}, ${column}, 'SELECT')`,
        ),
        sql` AND `,
      )}`,
    })
    .from(sql`(SELECT 1) AS reader_permission_probe`);
  return (permissions ?? panic("Reader privilege query returned no result"))
    .available;
};

type LegacyProvisionPageOptions = {
  subject: RedistributableDecisionSubject;
  cursor: ProvisionCursor | null;
  limit: number;
};

/** The expansion release still serves against the previous reader grants. */
const readLegacyProvisionPage = async ({
  subject: { id: decisionId, tx },
  cursor,
  limit,
}: LegacyProvisionPageOptions) => {
  if (cursor !== null && cursor.generation !== "0") {
    return paginationConflict();
  }
  const rows = await tx
    .select(LEGACY_CITATION_FIELDS)
    .from(caseLawProvisionCitations)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.id, caseLawProvisionCitations.decisionId),
    )
    .where(
      and(
        eq(caseLawProvisionCitations.decisionId, decisionId),
        isNull(caseLawDecisions.redactedAt),
        cursor === null
          ? undefined
          : sql`(${caseLawProvisionCitations.spanStart}, ${caseLawProvisionCitations.anchor}) > (${cursor.spanStart}::integer, ${cursor.anchor}::text)`,
      ),
    )
    .orderBy(
      asc(caseLawProvisionCitations.spanStart),
      asc(caseLawProvisionCitations.anchor),
    )
    .limit(limit + 1);
  return provisionPage({
    rows: rows.map((row) => Object.assign(row, UNAVAILABLE_SPAN_FIELDS)),
    limit,
    generation: "0",
    status: { type: "pending" },
    publishedProjectionDigest: null,
  });
};

const paginationConflict = () =>
  status(409, {
    type: "conflict",
    message: "Provision links changed; restart pagination",
  });

export const listDecisionProvisionsHandler = async ({
  subject,
  query,
}: ListDecisionProvisionsOptions) => {
  const { id: decisionId, tx } = subject;
  const limit = normalizeTenantPageLimit(
    query.limit ?? LIMITS.caseLawSearchPageSizeDefault,
  );
  const cursor = query.cursor ? decodeProvisionCursor(query.cursor) : null;
  if (query.cursor && cursor === null) {
    return status(400, { message: "Invalid cursor" });
  }

  if (!(await canReadProvisionStatus(tx))) {
    return await readLegacyProvisionPage({ subject, cursor, limit });
  }

  const decision = caseLawDecisions;
  const extraction = caseLawProvisionExtractions;
  const revisions = caseLawProvisionExtractionRevisions;
  const registry = caseLawProvisionExtractionRevisionsRegistry;
  // The scalar overload reads only the public columns; the enqueue trigger
  // delegates to the same digest implementation through its row overload.
  const inputDigest = sql`case_law_provision_extraction_input_digest(
    ${decision.contentHash}, ${decision.decisionDate}, ${decision.country},
    ${decision.language}, ${decision.redactedAt} IS NULL)`;
  const currentClassification = sql`${extraction.payloadClassInputDigest} = ${inputDigest}`;
  const conditions = {
    out_of_scope: sql`NOT case_law_provision_extraction_in_scope(${decision.country}, ${decision.language})`,
    withheld: sql`${decision.redactedAt} IS NOT NULL`,
    unavailable: sql`${inArray(decision.contentHash, EMPTY_CORPUS_CONTENT_HASHES)} OR
      (${currentClassification} AND ${extraction.payloadClass} = 'empty_envelope')`,
    unplaceable: sql`${decision.contentHash} IS NULL OR
      (${currentClassification} AND ${extraction.payloadClass} = 'unusable')`,
    failed: sql`${extraction.workStatus} = 'blocked'`,
    current: sql`${extraction.outcome} IN ('extracted_with_rows', 'extracted_zero')
      AND ${extraction.publishedInputDigest} = ${extraction.desiredInputDigest}
      AND ${extraction.desiredInputDigest} = ${inputDigest}
      AND ${extraction.publishedJurisdiction} = ${decision.country}
      AND ${extraction.publishedRevision} >= ${revisions.minCurrentRevision}
      AND ${registry.revision} IS NOT NULL`,
    stale: sql`${extraction.outcome} IS NOT NULL`,
    legacy: sql`EXISTS (SELECT 1 FROM ${caseLawProvisionCitations}
      WHERE ${caseLawProvisionCitations.decisionId} = ${decision.id})`,
    pending: sql`true`,
  } satisfies Record<ProvisionLinkStatus["type"], SQL>;
  const statusCase = sqlCaseFragment({
    branches: PROVISION_LINK_STATUS_TYPES.map(
      (type) => sql`WHEN ${conditions[type]} THEN ${type}::text`,
    ),
    fallback: sql`NULL`,
  }).mapWith((value: unknown): ProvisionLinkStatus => ({
    type: v.parse(v.picklist(PROVISION_LINK_STATUS_TYPES), value),
  }));
  const pageConditions = [
    eq(caseLawProvisionCitations.decisionId, decisionId),
    // A redacted decision's old citation excerpts must not escape its tombstone.
    isNull(decision.redactedAt),
    ...(cursor === null
      ? []
      : [
          sql`(${caseLawProvisionCitations.spanStart}, ${caseLawProvisionCitations.anchor}) > (${cursor.spanStart}::integer, ${cursor.anchor}::text)`,
        ]),
  ];

  const rows = await tx
    .select({
      status: statusCase,
      generation: sql<string>`coalesce(${extraction.generation}, 0)::text`,
      publishedProjectionDigest: sql<
        string | null
      >`encode(${extraction.publishedProjectionDigest}, 'hex')`,
      item: { ...LEGACY_CITATION_FIELDS, ...SPAN_CITATION_FIELDS },
    })
    .from(decision)
    .leftJoin(extraction, eq(extraction.decisionId, decision.id))
    .leftJoin(
      revisions,
      eq(revisions.jurisdiction, extraction.publishedJurisdiction),
    )
    .leftJoin(
      registry,
      and(
        eq(registry.jurisdiction, extraction.publishedJurisdiction),
        eq(registry.revision, extraction.publishedRevision),
      ),
    )
    .leftJoin(caseLawProvisionCitations, and(...pageConditions))
    .where(eq(decision.id, decisionId))
    .orderBy(
      asc(caseLawProvisionCitations.spanStart),
      asc(caseLawProvisionCitations.anchor),
    )
    .limit(limit + 1);

  // The decision was gated in this transaction's repeatable-read snapshot.
  const metadata = rows.at(0) ?? panic("Authorized decision disappeared");
  if (cursor !== null && cursor.generation !== metadata.generation) {
    return paginationConflict();
  }

  return provisionPage({
    rows: rows.flatMap(({ item }) => (item === null ? [] : [item])),
    limit,
    status: metadata.status,
    generation: metadata.generation,
    publishedProjectionDigest: metadata.publishedProjectionDigest,
  });
};
