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

import type { ExtractionWarnings } from "@stll/api-contract/case-law-extraction-warnings";
import type {
  CitationEvidenceIncompleteReason,
  CitationTextIncompleteReason,
  DecisionTextWithheldReason,
} from "@stll/api-contract/case-law-text-field";
import { CITATION_EVIDENCE_INCOMPLETE_REASON } from "@stll/api-contract/case-law-text-field";
import type { PublicCountrySurface } from "@stll/api-contract/public-country-capability";
import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { declareFingerprintFields } from "@stll/errors";
import {
  classifiedCitationBlockIds,
  findCitationPassage,
} from "@stll/legal-ast/citation-passage";
import type { CitationPassageMention } from "@stll/legal-ast/citation-passage";
import { hasBlockInlines, plainTextOf } from "@stll/legal-ast/document-ast";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  caseLawCitations,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import type { DecisionCitationRow } from "@/api/handlers/case-law/decisions/citation-graph";
import { listDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CitationEvidenceWindows } from "@/api/lib/case-law/citation-evidence";
import { citationTextRevisionFingerprintSql } from "@/api/lib/case-law/citation-text-revision";
import type {
  CitationPolaritySource,
  CitationReadDirection,
  CitationTreatment,
  CitedPart,
} from "@/api/lib/case-law/citation-vocabulary";
import { GRAPH_DIRECTION } from "@/api/lib/case-law/citation-vocabulary";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import {
  DECISION_ROW_AST_VERSION_CHANGED,
  readCachedDecisionRowAst,
} from "@/api/lib/case-law/decision-row-ast-cache";
import { readDecisionSectionIndex } from "@/api/lib/case-law/decision-section-cache";
import {
  decisionPayloadKey,
  readDecisionVersionedPayloads,
} from "@/api/lib/case-law/decision-versioned-payload";
import type {
  DecisionPayloadColumn,
  DecisionPayloadRead,
} from "@/api/lib/case-law/decision-versioned-payload";
import type { DoctrineTreatment } from "@/api/lib/case-law/doctrine";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { redistributableCaseLawSourceFor } from "@/api/lib/case-law/redistribution-sql";
import { pgTimestampCursorValue } from "@/api/lib/db-pagination";
import { errorTag } from "@/api/lib/errors/utils";
import { defineWindowedRead } from "@/api/lib/files/windowed-read-surface";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import { decisionTextWithheldReason } from "@/api/lib/legal-search/corpus-source";
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
  "citationText" | "evidenceQuote" | "printedBy"
> &
  CitationEvidenceFields & {
    textIncompleteReason: CitationTextIncompleteReason | null;
    citationText: string | null;
    extractionWarnings: ExtractionWarnings;
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
  | { type: "invalid_cursor" }
  | { type: "doctrine_unavailable" };

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
  versionTimestamp: string;
  textEligibilityFingerprint: string;
  extractionWarnings: ExtractionWarnings;
  textWithheldReason: DecisionTextWithheldReason | null;
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

export const readPassageSourcePointers = async (
  tx: CaseLawPublicReadTransaction,
  ids: readonly SafeId<"caseLawDecision">[],
  countries: readonly string[],
): Promise<PassageSourcePointer[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      extractionWarnings: publishedCaseLawDecisions.extractionWarnings,
      id: publishedCaseLawDecisions.id,
      astS3Key: publishedCaseLawDecisions.astS3Key,
      contentHash: publishedCaseLawDecisions.contentHash,
      updatedAt: publishedCaseLawDecisions.updatedAt,
      versionTimestamp: pgTimestampCursorValue(
        publishedCaseLawDecisions.updatedAt,
      ),
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
      textRevisionFingerprint,
      descriptor,
      ...row
    }) => ({
      ...row,
      ...passageTextEligibility({
        country,
        published,
        redistributable,
        textRevisionFingerprint,
        descriptor,
      }),
    }),
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
  classifiedBlockIds?: readonly string[] | undefined;
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
  classifiedBlockIds,
  evidenceQuote,
}: CitationPassageOptions): CitationPassage | null => {
  const match = findCitationPassage({
    blocks: ast.blocks,
    citationText,
    classifiedBlockIds,
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

/** A citing decision's text, as a passage read needs to see it. */
/** A failed eligibility gate carries an error, never fallback decision text. */
export class CitationTextGateError extends TaggedError(
  "CitationTextGateError",
)<{
  message: string;
  reason: Exclude<CitationTextIncompleteReason, "absent_ast">;
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type DecisionText = {
  ast: DocumentAst;
  sections: Awaited<ReturnType<typeof readDecisionSectionIndex>>;
  evidenceSections: DecisionSection[] | null;
};

const UNAVAILABLE_DECISION_TEXT = { type: "unavailable" } as const;

type DecisionTextRead =
  | typeof UNAVAILABLE_DECISION_TEXT
  | {
      type: "source";
      extractionWarnings: ExtractionWarnings;
      textWithheldReason: DecisionTextWithheldReason | null;
      text: DecisionText | null;
    };

/** The section a citation row was extracted from, when the row kept one. */
const sectionBlockIdsAt = (
  { ast, sections }: DecisionText,
  sectionIndex: number | null,
): readonly string[] | undefined => {
  if (sections === null || sectionIndex === null) {
    return undefined;
  }
  return classifiedCitationBlockIds(
    ast,
    sections.find((section) => section.index === sectionIndex)?.blockIndices,
  );
};

/**
 * One document read per distinct decision, a group at a time. The group is
 * the bound on bytes in flight: citation count does not bound document size,
 * so a page's decisions are never resolved together however many of them it
 * holds, and the group size is the concurrency. A document that cannot be
 * read costs its rows their passage, never the page: the citation and the
 * decision it names are still the answer to what the court cited.
 */
type DecisionTextGroupOptions = {
  readTombstones?: CorpusTombstoneReader;
  caseLawDb: CaseLawPublicReadDb;
  pointers: readonly PassageSourcePointer[];
  countries: readonly string[];
};

export const readDecisionTextGroup = async ({
  readTombstones = readCorpusTombstones,
  caseLawDb,
  pointers,
  countries,
}: DecisionTextGroupOptions): Promise<Map<string, DecisionTextRead>> => {
  const admissionMatches = async () => {
    const fresh = await caseLawDb(
      async (tx) =>
        await readPassageSourcePointers(
          tx,
          pointers.map(({ id }) => id),
          countries,
        ),
    );
    const freshById = new Map(fresh.map((pointer) => [pointer.id, pointer]));
    const locations = pointers.flatMap(({ astS3Key }) =>
      astS3Key === null ? [] : [astS3Key],
    );
    const tombstones = await readTombstones(locations);
    return new Set(
      pointers
        .filter((pointer) => {
          const current = freshById.get(pointer.id);
          return (
            current !== undefined &&
            current.textWithheldReason === null &&
            current.textEligibilityFingerprint ===
              pointer.textEligibilityFingerprint &&
            decisionPayloadKey(current) === decisionPayloadKey(pointer) &&
            (pointer.astS3Key === null || !tombstones.has(pointer.astS3Key))
          );
        })
        .map(({ id }) => id),
    );
  };
  const before = await Result.tryPromise(admissionMatches);
  if (Result.isError(before)) {
    logger.warn("case_law.citation_passage.eligibility_unavailable", {
      "error.type": errorTag(before.error),
    });
    return new Map(
      pointers.map(({ id }) => [String(id), UNAVAILABLE_DECISION_TEXT]),
    );
  }
  // Every lazy miss in this bounded group shares one version-qualified read.
  // Storage-backed AST hits never start the Postgres AST read.
  const payloadBatch = <K extends DecisionPayloadColumn>(column: K) => {
    let pending: Promise<Map<string, DecisionPayloadRead<K>>> | undefined;
    return async (pointer: PassageSourcePointer) => {
      pending ??= caseLawDb(
        async (tx) =>
          await readDecisionVersionedPayloads({
            tx,
            versions: pointers.filter(
              ({ textWithheldReason }) => textWithheldReason === null,
            ),
            column,
          }),
      );
      return (
        (await pending).get(pointer.id) ?? { kind: "version-changed" as const }
      );
    };
  };
  const readAst = payloadBatch("documentAst");
  const readSections = payloadBatch("sections");
  const changed = new Set<SafeId<"caseLawDecision">>();
  const entries = await Promise.all(
    pointers.map(async (pointer) => {
      if (
        pointer.textWithheldReason !== null ||
        !before.value.has(pointer.id)
      ) {
        return null;
      }
      const onVersionChanged = () => {
        changed.add(pointer.id);
      };
      const key = JSON.stringify([
        decisionPayloadKey(pointer),
        pointer.textEligibilityFingerprint,
      ]);
      const read = await Result.tryPromise(async () => {
        const ast = await readDecisionAnalysisAst(
          { ...pointer, documentAst: null },
          readTombstones,
          async () =>
            await readCachedDecisionRowAst({
              documentId: pointer.id,
              key,
              onVersionChanged,
              read: async () => {
                const result = await readAst(pointer);
                return result.kind === "version-changed"
                  ? DECISION_ROW_AST_VERSION_CHANGED
                  : result.value;
              },
            }),
        );
        if (changed.has(pointer.id) || ast === null) {
          return null;
        }
        const sections = await readDecisionSectionIndex({
          key,
          ast,
          onVersionChanged,
          readSections: async () => {
            const result = await readSections(pointer);
            return result.kind === "version-changed"
              ? DECISION_ROW_AST_VERSION_CHANGED
              : result.value;
          },
        });
        const evidence = await readSections(pointer);
        if (evidence.kind === "version-changed") {
          onVersionChanged();
          return null;
        }
        return changed.has(pointer.id)
          ? null
          : {
              id: pointer.id,
              text: { ast, sections, evidenceSections: evidence.value },
            };
      });
      if (Result.isError(read)) {
        logger.warn("case_law.citation_passage.ast_unavailable", {
          "error.type": errorTag(read.error),
        });
        return { status: "unavailable" as const, id: pointer.id };
      }
      return read.value === null
        ? null
        : {
            status: "found" as const,
            ...read.value,
            extractionWarnings: pointer.extractionWarnings,
          };
    }),
  );
  const textByDecision = new Map<string, DecisionTextRead>(
    pointers.map(({ id, textWithheldReason, extractionWarnings }) => [
      String(id),
      {
        type: "source" as const,
        textWithheldReason,
        extractionWarnings,
        text: null,
      },
    ]),
  );
  for (const entry of entries) {
    if (entry?.status === "unavailable") {
      textByDecision.set(entry.id, UNAVAILABLE_DECISION_TEXT);
    }
    if (entry?.status === "found") {
      textByDecision.set(entry.id, {
        type: "source",
        extractionWarnings: entry.extractionWarnings,
        textWithheldReason: null,
        text: entry.text,
      });
    }
  }
  const after = await Result.tryPromise(admissionMatches);
  for (const pointer of pointers) {
    if (
      pointer.textWithheldReason === null &&
      (changed.has(pointer.id) ||
        !before.value.has(pointer.id) ||
        Result.isError(after) ||
        !after.value.has(pointer.id))
    ) {
      textByDecision.set(pointer.id, UNAVAILABLE_DECISION_TEXT);
    }
  }
  return textByDecision;
};

type CitationTextRead = {
  citation: DecisionCitationRow;
  citingId: string;
  disposition: DecisionTextRead;
};

type ReadCitationTextsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  pointers: readonly PassageSourcePointer[];
  citations: readonly Omit<CitationTextRead, "disposition">[];
  countries: readonly string[];
};

const readCitationTexts = async ({
  caseLawDb,
  pointers,
  citations,
  countries,
}: ReadCitationTextsOptions): Promise<CitationTextRead[]> => {
  const admitted: CitationTextRead[] = citations.map(
    ({ citation, citingId }) => ({
      citation,
      citingId,
      disposition: UNAVAILABLE_DECISION_TEXT,
    }),
  );
  const textByDecision = new Map<string, DecisionTextRead>();
  for (const group of chunkItems(pointers, PASSAGE_AST_GROUP_SIZE)) {
    const entries = await readDecisionTextGroup({
      caseLawDb,
      pointers: group,
      countries,
    });
    for (const [id, text] of entries) {
      textByDecision.set(id, text);
    }
  }
  for (const entry of admitted) {
    const disposition = textByDecision.get(entry.citingId);
    if (disposition !== undefined) {
      entry.disposition = disposition;
    }
  }
  return admitted;
};

export type ReadDecisionCitationsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  cursor: string | undefined;
  decisionId: SafeId<"caseLawDecision">;
  direction: CitationReadDirection;
  doctrine?: Exclude<DoctrineTreatment, "not_stated">;
  polarity?: CitationTreatment;
  limit: number;
  /** The surface the read serves; its country list decides publication. */
  surface: PublicCountrySurface;
};

type PrepareDecisionCitationsOptions = {
  subject: RedistributableDecisionSubject;
  cursor: string | undefined;
  direction: CitationReadDirection;
  doctrine?: Exclude<DoctrineTreatment, "not_stated">;
  polarity?: CitationTreatment;
  limit: number;
};

const statusCodeOf = (result: { code: number | string }): number =>
  typeof result.code === "number" ? result.code : 500;

/** Gate metadata and offsets together; document bytes are read after it closes. */
export const prepareDecisionCitations = async ({
  subject,
  cursor,
  direction,
  doctrine,
  polarity,
  limit,
}: PrepareDecisionCitationsOptions) => {
  const decisionId = subject.id;
  const page = await listDecisionCitationsHandler({
    limit,
    query: {
      direction: GRAPH_DIRECTION[direction],
      ...(doctrine === undefined ? {} : { doctrine }),
      ...(polarity === undefined ? {} : { polarity }),
      ...(cursor === undefined ? {} : { cursor }),
    },
    subject,
  });
  if (page instanceof HttpStatusResponse) {
    const statusCode = statusCodeOf(page);
    if (statusCode === 422) {
      return { type: "doctrine_unavailable" as const };
    }
    if (statusCode === 400) {
      return { type: "invalid_cursor" as const };
    }
    return panic(`Unexpected citation list status ${String(statusCode)}`);
  }
  // Whose text holds the citing block: this decision for its own outgoing
  // citations, the citing decision for every incoming one.
  const citingIds = [
    ...new Map(
      page.items.map(
        (item) => [String(item.printedBy), item.printedBy] as const,
      ),
    ).values(),
  ];
  const sources = await readPassageSourcePointers(
    subject.tx,
    citingIds,
    subject.countries,
  );
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
  if (
    gated.type === "invalid_cursor" ||
    gated.type === "doctrine_unavailable"
  ) {
    return gated;
  }
  const resolved = await readCitationTexts({
    caseLawDb,
    pointers: gated.sources,
    countries: gated.countries,
    citations: gated.page.items.map((citation) => ({
      citation,
      citingId: String(citation.printedBy),
    })),
  });
  const textByDecision = new Map(
    resolved.map(({ citingId, disposition }) => [citingId, disposition]),
  );
  const evidenceByCitation = new Map(
    gated.evidence.type === "ready"
      ? gated.evidence.rows.map((row) => [String(row.id), row] as const)
      : [],
  );
  const items = gated.page.items.map((item): CitationWithPassage => {
    const disposition = textByDecision.get(String(item.printedBy));
    const textWithheldReason =
      disposition?.type === "source" ? disposition.textWithheldReason : null;
    let text: CitationDecisionText;
    if (disposition?.type === "source" && disposition.text !== null) {
      text = {
        type: "eligible",
        ast: disposition.text.ast,
        sections: disposition.text.evidenceSections,
      };
    } else if (disposition?.type === "source" && textWithheldReason === null) {
      text = { type: "absent-ast" };
    } else if (textWithheldReason !== null) {
      text = { type: "withheld", reason: textWithheldReason };
    } else {
      text = {
        type: "gate-failed",
        error: new CitationTextGateError({
          message: "Citation text admission changed or could not be read",
          reason: "gate_failed",
        }),
      };
    }
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
    const {
      evidenceQuote: _evidenceQuote,
      printedBy: _printedBy,
      ...citation
    } = item;
    let passage: CitationPassage | null = null;
    if (
      !(gated.evidence.type === "ready" && evidence === null) &&
      disposition?.type === "source" &&
      disposition.text !== null &&
      textWithheldReason === null
    ) {
      passage = citationPassageIn({
        ast: disposition.text.ast,
        citationText: item.citationText,
        classifiedBlockIds: sectionBlockIdsAt(
          disposition.text,
          item.sectionIndex,
        ),
        evidenceQuote:
          item.doctrine === "distinguishes" || item.doctrine === "limits"
            ? item.evidenceQuote
            : null,
      });
    }
    return {
      ...citation,
      extractionWarnings:
        disposition?.type === "source" ? disposition.extractionWarnings : [],
      ...evidenceFields,
      citationText:
        gated.evidence.type === "ready" && evidence === null
          ? null
          : textFields.citationText,
      textIncompleteReason: textFields.textIncompleteReason,
      textWithheldReason,
      passage,
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

export type CitationDecisionText =
  | { type: "eligible"; ast: DocumentAst; sections: DecisionSection[] | null }
  | { type: "withheld"; reason: DecisionTextWithheldReason }
  | { type: "absent-ast" }
  | { type: "gate-failed"; error: CitationTextGateError };

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

export const readGatedDecisionCitations = defineWindowedRead(
  "citation-passages",
  async ({
    caseLawDb,
    cursor,
    decisionId,
    direction,
    doctrine,
    polarity,
    limit,
    surface,
  }: ReadDecisionCitationsOptions): Promise<DecisionCitationsRead | null> => {
    const prepared = await withRedistributableSubject(
      caseLawDb,
      surface,
      { kind: "id", id: decisionId },
      async (subject) =>
        await prepareDecisionCitations({
          subject,
          cursor,
          direction,
          ...(doctrine === undefined ? {} : { doctrine }),
          ...(polarity === undefined ? {} : { polarity }),
          limit,
        }),
    );
    return prepared === null
      ? null
      : await completeDecisionCitations({ caseLawDb, prepared });
  },
);
