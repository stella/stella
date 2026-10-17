/**
 * The citation graph with the text that drew each edge.
 *
 * `listDecisionCitationsHandler` answers which decisions a decision cites and
 * which cite it; on its own that is a list of names. What a reader, or an
 * agent, asks next is what the citing court actually said, so this read adds
 * the citing paragraph to every row.
 *
 * The paragraph lives in the decision's AST, which is object storage under
 * canonical corpus mode. Fetching it must not hold the gated read transaction
 * open, so the shape here mirrors `readGatedDecisionWithDocument`: gate the
 * citations and resolve where each document lives inside one transaction,
 * then read the documents in bounded groups once it has closed. Nothing a
 * citation count could multiply is read while the gate's transaction is open.
 */
import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  CitationEvidenceIncompleteReason,
  CitationTextIncompleteReason,
  DecisionTextWithheldReason,
} from "@stll/api-contract/case-law-text-field";
import { CITATION_EVIDENCE_INCOMPLETE_REASON } from "@stll/api-contract/case-law-text-field";
import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { findCitationPassage } from "@stll/legal-ast/citation-passage";
import type { CitationPassageMention } from "@stll/legal-ast/citation-passage";
import { hasBlockInlines, plainTextOf } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  caseLawCitations,
  publishedCaseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import type { DecisionCitationRow } from "@/api/handlers/case-law/decisions/citation-graph";
import { listDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CitationEvidenceWindows } from "@/api/lib/case-law/citation-evidence";
import { citationTextRevisionFingerprintSql } from "@/api/lib/case-law/citation-text-revision";
import type {
  CitationReadDirection,
  CitationPolaritySource,
  CitedPart,
} from "@/api/lib/case-law/citation-vocabulary";
import { GRAPH_DIRECTION } from "@/api/lib/case-law/citation-vocabulary";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";
import { decisionTextWithheldReason } from "@/api/lib/legal-search/corpus-source";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  CITATION_POLARITY_EVIDENCE_COLUMN_GRANTS_BY_RELATION,
  publicLawColumnPairs,
} from "@/api/lib/public-law-relations";

/** The paragraph an agent is given per citation, and its deep-link anchor. */
export type CitationPassage = {
  anchorId: string;
  /** An excerpt, not the block, whenever `truncated` is true. */
  text: string;
  truncated: boolean;
  mention: CitationPassageMention;
  evidenceQuote?: string;
  evidenceAnchorId?: string | null;
};

export type CitationPolarityEvidence = {
  source: CitationPolaritySource | null;
  ruleId: SafeId<"caseLawPolarityRule"> | null;
  classifierVersion: string | null;
  excerpt: string | null;
};

type CitationEvidenceFields =
  | {
      evidenceIncompleteReason: null;
      polarityEvidence: CitationPolarityEvidence;
      citedPart: CitedPart;
    }
  | {
      evidenceIncompleteReason: CitationEvidenceIncompleteReason;
      polarityEvidence: null;
      citedPart: null;
    };

export type CitationWithPassage = Omit<
  DecisionCitationRow,
  "citationText" | "evidenceQuote"
> &
  CitationEvidenceFields & {
    citationText: string | null;
    textIncompleteReason: CitationTextIncompleteReason | null;
    textWithheldReason: DecisionTextWithheldReason | null;
    /**
     * The citing block, or null where there is none to give: the source bars
     * derived AI use, the decision's document is not parsed, its object could
     * not be read, or no block carries the citation's text.
     */
    passage: CitationPassage | null;
  };

export type DecisionCitationsPage = {
  doctrineAvailability: "available" | "unavailable";
  items: CitationWithPassage[];
  nextCursor: string | null;
};

/** An invalid cursor, told apart from "no such public decision" (null). */
export type DecisionCitationsRead =
  | { type: "page"; page: DecisionCitationsPage }
  | { type: "invalid_cursor" };

/**
 * How much of the citing paragraph travels with a citation. A decision's
 * paragraphs run to thousands of characters and a page carries up to
 * `caseLawDecisionCitationPageSize` of them, so the excerpt is centred on the
 * citation rather than sent whole.
 */
const PASSAGE_MAX_CHARS = LIMITS.caseLawCitationPassageChars;

/** Documents whose AST is fetched at once while resolving one page. */
const PASSAGE_AST_GROUP_SIZE = LIMITS.caseLawCitationPassageConcurrency;

/**
 * Which decisions a passage read may take text from, and where their AST
 * lives. Deliberately no `documentAst`: under `corpusStorageMode: "off"` that
 * column IS the document, so selecting it for a whole page would pull up to
 * `limit` independently unbounded JSONB documents into the gated
 * repeatable-read transaction. The bytes are read in bounded groups after the
 * gate closes instead.
 */
type PassageSourcePointer = {
  id: SafeId<"caseLawDecision">;
  astS3Key: string | null;
  contentHash: string | null;
  textEligibilityFingerprint: string;
};

type PassageTextEligibility = {
  country: string;
  published: boolean;
  redistributable: boolean;
  textRevisionFingerprint: string;
  descriptor: Pick<CorpusSourceDescriptor, "allowsDerivedAi"> | null;
};

/** Both phases bind country, text revision and source disposition to the publication gate. */
export const passageTextEligibility = ({
  country,
  published,
  redistributable,
  textRevisionFingerprint,
  descriptor,
}: PassageTextEligibility) => ({
  textEligibilityFingerprint: JSON.stringify([
    country,
    published,
    textRevisionFingerprint,
    redistributable,
    decisionTextWithheldReason(descriptor),
  ]),
  textWithheldReason: decisionTextWithheldReason(descriptor),
});

const passageTextEligibilityColumns = {
  country: publishedCaseLawDecisions.country,
  published: sql<boolean>`true`,
  redistributable: sql<boolean>`${redistributableCaseLawSourceFor(caseLawSources.descriptor)}`,
  textRevisionFingerprint: citationTextRevisionFingerprintSql({
    contentHash: publishedCaseLawDecisions.contentHash,
    sections: publishedCaseLawDecisions.sections,
  }),
  descriptor: caseLawSources.descriptor,
};

const passageTextEligibilityGate = redistributableCaseLawSourceFor(
  caseLawSources.descriptor,
);

type ReadPassageSourcePointersOptions = {
  tx: CaseLawPublicReadTransaction;
  ids: readonly SafeId<"caseLawDecision">[];
  countries: readonly string[];
};

const readPassageSourcePointers = async ({
  tx,
  ids,
  countries,
}: ReadPassageSourcePointersOptions): Promise<PassageSourcePointer[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      id: publishedCaseLawDecisions.id,
      astS3Key: publishedCaseLawDecisions.astS3Key,
      contentHash: publishedCaseLawDecisions.contentHash,
      ...passageTextEligibilityColumns,
    })
    .from(publishedCaseLawDecisions)
    .innerJoin(
      caseLawSources,
      eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
    )
    .where(
      and(
        inArray(publishedCaseLawDecisions.id, [...ids]),
        inArray(publishedCaseLawDecisions.country, [...countries]),
        passageTextEligibilityGate,
      ),
    );
  // The same split the decision read makes: redistribution decides whether a
  // citation may be listed at all, derived AI whether its text may travel
  // with it.
  return rows.map(
    ({
      country,
      published,
      redistributable,
      descriptor,
      textRevisionFingerprint,
      ...row
    }) => ({
      ...row,
      textEligibilityFingerprint: passageTextEligibility({
        country,
        published,
        redistributable,
        descriptor,
        textRevisionFingerprint,
      }).textEligibilityFingerprint,
    }),
  );
};

/**
 * What one group of citing decisions holds in its own columns, read outside
 * the gate's transaction.
 *
 * `documentAst` is the fallback for a canonical row whose object cannot be
 * read, and is the whole document under `corpusStorageMode: "off"`.
 * `sections` is the segmentation the citation extractor indexed and the
 * polarity classifier read, which is what lets a passage be anchored to the
 * mention the treatment came from.
 */
type DecisionTextColumns = {
  contentHash: string | null;
  textEligibilityFingerprint: string;
  textWithheldReason: DecisionTextWithheldReason | null;
  documentAst: unknown;
  sections: DecisionSection[] | null;
};

type ReadDecisionTextColumnsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  ids: readonly SafeId<"caseLawDecision">[];
  countries: readonly string[];
};

const readDecisionTextColumns = async ({
  caseLawDb,
  ids,
  countries,
}: ReadDecisionTextColumnsOptions): Promise<
  Map<string, DecisionTextColumns>
> => {
  const rows = await caseLawDb(
    async (tx) =>
      await tx
        .select({
          id: publishedCaseLawDecisions.id,
          documentAst: publishedCaseLawDecisions.documentAst,
          contentHash: publishedCaseLawDecisions.contentHash,
          ...passageTextEligibilityColumns,
          sections: publishedCaseLawDecisions.sections,
        })
        .from(publishedCaseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, publishedCaseLawDecisions.sourceId),
        )
        .where(
          and(
            inArray(publishedCaseLawDecisions.id, [...ids]),
            inArray(publishedCaseLawDecisions.country, [...countries]),
            passageTextEligibilityGate,
          ),
        ),
  );
  return new Map(
    rows.map(
      ({
        id,
        country,
        published,
        redistributable,
        descriptor,
        textRevisionFingerprint,
        ...columns
      }) =>
        [
          String(id),
          {
            ...columns,
            ...passageTextEligibility({
              country,
              published,
              redistributable,
              descriptor,
              textRevisionFingerprint,
            }),
          },
        ] as const,
    ),
  );
};

type Excerpt = { text: string; truncated: boolean };

/**
 * A paragraph runs to thousands of characters and a page carries up to
 * `caseLawDecisionCitationPageSize` of them, so what travels with a citation
 * is centred on the citation rather than sent whole.
 */
const excerptAround = (text: string, at: number, length: number): Excerpt => {
  if (text.length <= PASSAGE_MAX_CHARS) {
    return { text, truncated: false };
  }
  const margin = Math.max(0, Math.floor((PASSAGE_MAX_CHARS - length) / 2));
  const start = Math.max(
    0,
    Math.min(at - margin, text.length - PASSAGE_MAX_CHARS),
  );
  return {
    text: text.slice(start, start + PASSAGE_MAX_CHARS),
    truncated: true,
  };
};

export type CitationPassageOptions = {
  ast: DocumentAst;
  citationText: string;
  /** The section the citation row was extracted from, when the row kept it. */
  sectionText: string | undefined;
  evidenceQuote?: string | null;
};

/**
 * The citing paragraph as an agent-facing reply carries it: the block
 * `findCitationPassage` chose, cut to the reply's budget.
 *
 * Choosing the block is the shared rule, not this read's: the app reader
 * marks every mention over the same locator, so a citation cannot be
 * highlighted in one paragraph and quoted from another.
 */
export const citationPassageIn = ({
  ast,
  citationText,
  sectionText,
  evidenceQuote,
}: CitationPassageOptions): CitationPassage | null => {
  const match = findCitationPassage({
    blocks: ast.blocks,
    citationText,
    sectionText,
  });
  if (match === null) {
    return null;
  }
  // The quote anchors to the paragraph that carries it, which need not repeat
  // the citation: a court often discusses a precedent in the paragraph after
  // the one naming it. The citing paragraph wins when it carries the quote.
  const quoteBlocks =
    evidenceQuote === null || evidenceQuote === undefined
      ? []
      : ast.blocks.filter(
          (block) =>
            hasBlockInlines(block) &&
            plainTextOf(block.inlines).includes(evidenceQuote),
        );
  const evidenceBlock =
    quoteBlocks.find((block) => block.id === match.blockId) ??
    quoteBlocks.at(0);
  if (
    evidenceQuote !== null &&
    evidenceQuote !== undefined &&
    evidenceBlock === undefined
  ) {
    logger.warn("case_law.citation_passage.doctrine_evidence_unavailable", {});
  }
  const excerpt = excerptAround(
    match.text,
    match.start,
    match.end - match.start,
  );
  return {
    anchorId: match.anchorId,
    text: excerpt.text,
    truncated: excerpt.truncated,
    mention: match.mention,
    ...(evidenceBlock === undefined ||
    evidenceQuote === null ||
    evidenceQuote === undefined
      ? {}
      : { evidenceQuote, evidenceAnchorId: evidenceBlock.anchorId }),
  };
};

/** A failed eligibility gate carries an error, never fallback decision text. */
export class CitationTextGateError extends TaggedError(
  "CitationTextGateError",
)<{
  message: string;
  reason: Exclude<CitationTextIncompleteReason, "absent_ast">;
  cause?: unknown;
}> {}

export type CitationDecisionText =
  | { type: "eligible"; ast: DocumentAst; sections: DecisionSection[] | null }
  | { type: "withheld"; reason: DecisionTextWithheldReason }
  | { type: "absent-ast" }
  | { type: "gate-failed"; error: CitationTextGateError };

type ReadCitationDecisionTextOptions = {
  pointer: PassageSourcePointer;
  columns: DecisionTextColumns | undefined;
  readAst?: typeof readDecisionAnalysisAst;
  readTombstones?: CorpusTombstoneReader;
};

/** Failed eligibility reads never retain sections as a fallback text source. */
export const readCitationDecisionText = async ({
  pointer,
  columns,
  readAst = readDecisionAnalysisAst,
  readTombstones = readCorpusTombstones,
}: ReadCitationDecisionTextOptions): Promise<CitationDecisionText> => {
  if (columns !== undefined && columns.textWithheldReason !== null) {
    return { type: "withheld", reason: columns.textWithheldReason };
  }
  if (
    columns === undefined ||
    columns.textEligibilityFingerprint !== pointer.textEligibilityFingerprint
  ) {
    return {
      type: "gate-failed",
      error: new CitationTextGateError({
        message: "Citation decision text is missing or changed",
        reason: columns === undefined ? "missing_text" : "text_changed",
      }),
    };
  }
  // Check denial before the AST reader can recover an object read with its
  // database copy. The reader only fetches this pointer's AST location.
  const locations = pointer.astS3Key === null ? [] : [pointer.astS3Key];
  const tombstones = await Result.tryPromise({
    try: async () => await readTombstones(locations),
    catch: (cause) =>
      new CitationTextGateError({
        message: "Citation decision denial list could not be read",
        reason: "gate_failed",
        cause,
      }),
  });
  if (Result.isError(tombstones)) {
    return { type: "gate-failed", error: tombstones.error };
  }
  if (locations.some((location) => tombstones.value.has(location))) {
    return {
      type: "gate-failed",
      error: new CitationTextGateError({
        message: "Citation decision text has been erased",
        reason: "gate_failed",
      }),
    };
  }
  const deniedLocations = Promise.resolve(tombstones.value);
  const read = await Result.tryPromise(
    async () =>
      await readAst(
        { ...pointer, documentAst: columns.documentAst },
        async () => await deniedLocations,
      ),
  );
  if (Result.isError(read)) {
    return {
      type: "gate-failed",
      error: new CitationTextGateError({
        message: "Citation decision text eligibility could not be read",
        reason: "gate_failed",
        cause: read.error,
      }),
    };
  }
  if (read.value === null) {
    return { type: "absent-ast" };
  }
  return { type: "eligible", ast: read.value, sections: columns.sections };
};

/** The section a citation row was extracted from, when the row kept one. */
const sectionTextAt = (
  sections: DecisionSection[] | null,
  sectionIndex: number | null,
): string | undefined => {
  if (sections === null || sectionIndex === null) {
    return undefined;
  }
  return sections.find((section) => section.index === sectionIndex)?.text;
};

/**
 * One document read per distinct decision, a group at a time. The group is
 * the bound on bytes in flight: citation count does not bound document size,
 * so a page's decisions are never resolved together however many of them it
 * holds, and the group size is the concurrency. A document that cannot be
 * read costs its rows every text field, never the page: the decision identity
 * and treatment metadata remain available with an explicit incomplete reason.
 */
type ReadDecisionTextByDecisionOptions = {
  caseLawDb: CaseLawPublicReadDb;
  pointers: readonly PassageSourcePointer[];
  countries: readonly string[];
};

const readDecisionTextByDecision = async ({
  caseLawDb,
  pointers,
  countries,
}: ReadDecisionTextByDecisionOptions): Promise<
  Map<string, CitationDecisionText>
> => {
  const textByDecision = new Map<string, CitationDecisionText>();
  for (const group of chunkItems(pointers, PASSAGE_AST_GROUP_SIZE)) {
    const columns = await readDecisionTextColumns({
      caseLawDb,
      ids: group.map((pointer) => pointer.id),
      countries,
    });
    const entries = await Promise.all(
      group.map(async (pointer) => {
        const text = await readCitationDecisionText({
          pointer,
          columns: columns.get(String(pointer.id)),
        });
        if (text.type === "gate-failed") {
          captureError(text.error, {
            step: "case_law.citation_passage.text_gate",
          });
        }
        return { id: pointer.id, text };
      }),
    );
    for (const entry of entries) {
      textByDecision.set(String(entry.id), entry.text);
    }
  }
  return textByDecision;
};

export type ReadDecisionCitationsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  cursor: string | undefined;
  decisionId: SafeId<"caseLawDecision">;
  direction: CitationReadDirection;
  limit: number;
  surface: PublicCountrySurface;
};

type PrepareDecisionCitationsOptions = {
  subject: RedistributableDecisionSubject;
  cursor: string | undefined;
  direction: CitationReadDirection;
  limit: number;
};

/** Gate metadata and offsets together; document bytes are read after it closes. */
export const prepareDecisionCitations = async ({
  subject,
  cursor,
  direction,
  limit,
}: PrepareDecisionCitationsOptions) => {
  const decisionId = subject.id;
  const page = await listDecisionCitationsHandler({
    limit,
    query: {
      direction: GRAPH_DIRECTION[direction],
      ...(cursor === undefined ? {} : { cursor }),
    },
    subject,
  });
  if (!("items" in page)) {
    return { type: "invalid_cursor" } as const;
  }
  // Whose text holds the citing block: this decision for its own outgoing
  // citations, the citing decision for every incoming one.
  const citingIds =
    direction === "cites"
      ? [decisionId]
      : [
          ...new Map(
            page.items.flatMap((item) =>
              item.decision === null
                ? []
                : [[String(item.decision.id), item.decision.id] as const],
            ),
          ).values(),
        ];
  const sources = await readPassageSourcePointers({
    tx: subject.tx,
    ids: citingIds,
    countries: subject.countries,
  });
  const [permission] = await subject.tx
    .select({
      available: sql<boolean>`${sql.join(
        publicLawColumnPairs(
          CITATION_POLARITY_EVIDENCE_COLUMN_GRANTS_BY_RELATION,
        ).map(
          ({ relation, column }) =>
            sql`has_column_privilege(current_user, ${`public.${relation}`}, ${column}, 'SELECT')`,
        ),
        sql` AND `,
      )}`,
    })
    .from(sql`(SELECT 1) AS reader_permission_probe`);
  if (permission === undefined) {
    panic("Reader privilege query returned no result");
  }
  if (!permission.available) {
    return {
      page,
      sources,
      countries: subject.countries,
      resolvedDecisionId: decisionId,
      direction,
      evidence: { type: "not-granted" as const },
      type: "page" as const,
    };
  }
  const evidence = {
    type: "ready" as const,
    rows:
      page.items.length === 0
        ? []
        : await subject.tx
            .select({
              id: caseLawCitations.id,
              source: caseLawCitations.polaritySource,
              ruleId: caseLawCitations.polarityRuleId,
              classifierVersion: caseLawCitations.polarityClassifierVersion,
              evidenceWindows: caseLawCitations.polarityEvidenceWindows,
              citedPart: caseLawCitations.citedPart,
            })
            .from(caseLawCitations)
            .where(
              inArray(
                caseLawCitations.id,
                page.items.map(({ id }) => id),
              ),
            ),
  };
  return {
    page,
    sources,
    countries: subject.countries,
    evidence,
    resolvedDecisionId: decisionId,
    direction,
    type: "page" as const,
  };
};

type PreparedDecisionCitations = Awaited<
  ReturnType<typeof prepareDecisionCitations>
>;

type CompleteDecisionCitationsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  prepared: PreparedDecisionCitations;
};

/** Resolve both display passages and exact classifier windows through one text owner. */
export const completeDecisionCitations = async ({
  caseLawDb,
  prepared: gated,
}: CompleteDecisionCitationsOptions): Promise<DecisionCitationsRead> => {
  if (gated.type === "invalid_cursor") {
    return gated;
  }
  const textByDecision = await readDecisionTextByDecision({
    caseLawDb,
    pointers: gated.sources,
    countries: gated.countries,
  });
  const evidenceByCitation = new Map(
    gated.evidence.type === "ready"
      ? gated.evidence.rows.map((row) => [String(row.id), row] as const)
      : [],
  );
  const items = gated.page.items.map((item): CitationWithPassage => {
    const citingId =
      gated.direction === "cites"
        ? String(gated.resolvedDecisionId)
        : String(item.decision?.id);
    const text = textByDecision.get(citingId);
    const textWithheldReason = text?.type === "withheld" ? text.reason : null;
    const evidence =
      gated.evidence.type === "not-granted"
        ? null
        : (evidenceByCitation.get(String(item.id)) ?? null);
    const textFields = citationTextFields({
      text,
      textWithheldReason,
      citationText: item.citationText,
      sectionIndex: item.sectionIndex,
      evidenceWindows: evidence?.evidenceWindows ?? null,
      evidenceQuote:
        item.doctrine === "distinguishes" || item.doctrine === "limits"
          ? item.evidenceQuote
          : null,
    });
    const evidenceFields: CitationEvidenceFields =
      evidence === null
        ? {
            evidenceIncompleteReason:
              gated.evidence.type === "not-granted"
                ? CITATION_EVIDENCE_INCOMPLETE_REASON.MISSING_PRIVILEGES
                : CITATION_EVIDENCE_INCOMPLETE_REASON.MISSING_EVIDENCE,
            citedPart: null,
            polarityEvidence: null,
          }
        : {
            evidenceIncompleteReason: null,
            citedPart: evidence.citedPart,
            polarityEvidence: {
              source: evidence.source,
              ruleId: evidence.ruleId,
              classifierVersion: evidence.classifierVersion,
              excerpt: textFields.evidenceExcerpt,
            },
          };
    const { evidenceQuote: _evidenceQuote, ...citation } = item;
    return {
      ...citation,
      ...evidenceFields,
      citationText:
        gated.evidence.type === "ready" && evidence === null
          ? null
          : textFields.citationText,
      textIncompleteReason: textFields.textIncompleteReason,
      textWithheldReason,
      passage:
        gated.evidence.type === "ready" && evidence === null
          ? null
          : textFields.passage,
    };
  });

  return {
    page: {
      items,
      nextCursor: gated.page.nextCursor,
      doctrineAvailability: gated.page.doctrineAvailability,
    },
    type: "page",
  };
};

/** Null windows mean no evidence was recorded; never substitute a nearby mention. */
type PolarityExcerptOptions = {
  sections: DecisionSection[] | null;
  evidenceWindows: CitationEvidenceWindows | null;
};

export const polarityExcerptIn = ({
  sections,
  evidenceWindows,
}: PolarityExcerptOptions): string | null => {
  if (sections === null || evidenceWindows === null) {
    return null;
  }
  const text = sections.map((section) => section.text).join("\n");
  if (
    evidenceWindows.some(
      ({ start, end }) => start < 0 || end <= start || end > text.length,
    )
  ) {
    logger.warn("case_law.citation_polarity.evidence_window_out_of_bounds");
    return null;
  }
  const omission = "\n[…]\n";
  const windowBudget = Math.floor(
    (PASSAGE_MAX_CHARS - omission.length * (evidenceWindows.length - 1)) /
      evidenceWindows.length,
  );
  if (windowBudget <= omission.length) {
    logger.warn(
      "case_law.citation_polarity.evidence_windows_exceed_excerpt_budget",
    );
    return null;
  }
  return evidenceWindows
    .map(({ start, end }) => {
      if (end - start <= windowBudget) {
        return text.slice(start, end);
      }
      const prefixLength = Math.floor((windowBudget - omission.length) / 2);
      const suffixLength = windowBudget - omission.length - prefixLength;
      return (
        text.slice(start, start + prefixLength) +
        omission +
        text.slice(end - suffixLength, end)
      );
    })
    .join(omission);
};

export const readGatedDecisionCitations = async ({
  caseLawDb,
  cursor,
  decisionId,
  direction,
  limit,
  surface,
}: ReadDecisionCitationsOptions): Promise<DecisionCitationsRead | null> => {
  const prepared = await withRedistributableSubject(
    caseLawDb,
    surface,
    { kind: "id", id: decisionId },
    async (subject) =>
      await prepareDecisionCitations({ subject, cursor, direction, limit }),
  );
  if (prepared === null) {
    return null;
  }
  return await completeDecisionCitations({
    caseLawDb,
    prepared,
  });
};

type CitationTextFieldsOptions = {
  text: CitationDecisionText | undefined;
  textWithheldReason: DecisionTextWithheldReason | null;
  citationText: string;
  sectionIndex: number | null;
  evidenceWindows: CitationEvidenceWindows | null;
  evidenceQuote?: string | null;
};

/** All citation text outputs share one eligibility branch, including the reference itself. */
export const citationTextFields = ({
  text,
  textWithheldReason,
  citationText,
  sectionIndex,
  evidenceWindows,
  evidenceQuote = null,
}: CitationTextFieldsOptions) => {
  if (textWithheldReason !== null) {
    return {
      citationText: null,
      passage: null,
      evidenceExcerpt: null,
      textIncompleteReason: null,
    };
  }
  if (text === undefined) {
    return {
      citationText: null,
      passage: null,
      evidenceExcerpt: null,
      textIncompleteReason: "missing_text" as const,
    };
  }
  switch (text.type) {
    case "eligible":
      return {
        citationText,
        passage: citationPassageIn({
          ast: text.ast,
          citationText,
          sectionText: sectionTextAt(text.sections, sectionIndex),
          evidenceQuote,
        }),
        evidenceExcerpt: polarityExcerptIn({
          sections: text.sections,
          evidenceWindows,
        }),
        textIncompleteReason: null,
      };
    case "absent-ast":
      return {
        citationText,
        passage: null,
        evidenceExcerpt: null,
        textIncompleteReason: "absent_ast" as const,
      };
    case "withheld":
      return {
        citationText: null,
        passage: null,
        evidenceExcerpt: null,
        textIncompleteReason: null,
      };
    case "gate-failed":
      return {
        citationText: null,
        passage: null,
        evidenceExcerpt: null,
        textIncompleteReason: text.error.reason,
      };
    default:
      text satisfies never;
      return panic("Unhandled citation decision text gate");
  }
};
