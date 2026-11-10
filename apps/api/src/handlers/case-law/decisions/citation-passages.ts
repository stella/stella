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
import {
  decisionTextCompletionColumns,
  decisionTextCompletionGate,
  decisionTextCompletionOf,
} from "@/api/handlers/case-law/decisions/text-completion";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CitationEvidenceWindows } from "@/api/lib/case-law/citation-evidence";
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
import type { RedistributableDecisionSubject } from "@/api/lib/case-law/public-subject";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { pgTimestampCursorValue } from "@/api/lib/db-pagination";
import { defineWindowedRead } from "@/api/lib/files/windowed-read-surface";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";
import type { CorpusTombstoneReader } from "@/api/lib/legal-search/corpus-tombstones";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
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
  /** Rows the page read before a passage filter, present only with one. */
  scannedCitations?: number;
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

/**
 * Keeps a citation by the text of its citing paragraph, in that decision's
 * language: the whole paragraph, not the excerpt a reply carries of it.
 */
export type CitationPassageFilter = (
  paragraph: string,
  language: string,
) => boolean;

/** Documents whose AST is fetched at once while resolving one page. */
const PASSAGE_AST_GROUP_SIZE = LIMITS.caseLawCitationPassageConcurrency;
const PASSAGE_VERSION_ATTEMPTS = 3;

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
  language: string;
  versionTimestamp: string;
  textEligibilityFingerprint: string;
  extractionWarnings: ExtractionWarnings;
  textWithheldReason: DecisionTextWithheldReason | null;
};

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
      language: publishedCaseLawDecisions.language,
      updatedAt: publishedCaseLawDecisions.updatedAt,
      versionTimestamp: pgTimestampCursorValue(
        publishedCaseLawDecisions.updatedAt,
      ),
      ...decisionTextCompletionColumns,
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
        decisionTextCompletionGate,
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
      documentUrl,
      textRevisionFingerprint,
      descriptor,
      ...row
    }) => {
      const { textEligibilityFingerprint, textWithheldReason } =
        decisionTextCompletionOf({
          country,
          published,
          redistributable,
          documentUrl,
          textRevisionFingerprint,
          descriptor,
        });
      return { ...row, textEligibilityFingerprint, textWithheldReason };
    },
  );
};

type Excerpt = { text: string; truncated: boolean };

/**
 * A paragraph runs to thousands of characters and a page carries up to
 * `caseLawDecisionCitationPageSize` of them, so what travels with a citation
 * is centred on the citation rather than sent whole.
 */
const excerptAround = (
  text: string,
  { at, length, maxChars }: { at: number; length: number; maxChars: number },
): Excerpt => {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  const margin = Math.max(0, Math.floor((maxChars - length) / 2));
  const start = Math.max(0, Math.min(at - margin, text.length - maxChars));
  return {
    text: text.slice(start, start + maxChars),
    truncated: true,
  };
};

export type CitationPassageOptions = {
  ast: DocumentAst;
  citationText: string;
  /** The section the citation row was extracted from, when the row kept it. */
  classifiedBlockIds?: readonly string[] | undefined;
  evidenceQuote?: string | null;
  /** Excerpt length; `PASSAGE_MAX_CHARS` when absent. */
  maxChars?: number | undefined;
  /** No passage when the citing paragraph does not satisfy this. */
  paragraphMatches?: ((paragraph: string) => boolean) | undefined;
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
  maxChars = PASSAGE_MAX_CHARS,
  paragraphMatches,
}: CitationPassageOptions): CitationPassage | null => {
  const match = findCitationPassage({
    blocks: ast.blocks,
    citationText,
    classifiedBlockIds,
  });
  if (
    match === null ||
    (paragraphMatches !== undefined && !paragraphMatches(match.text))
  ) {
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
  const excerpt = excerptAround(match.text, {
    at: match.start,
    length: match.end - match.start,
    maxChars,
  });
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
  language: string;
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
const citationTextReadFailure = failureSink({
  event: "case_law.citation_passage.text_unavailable",
  expected: [],
});

type DecisionTextGroupOptions = {
  readTombstones?: CorpusTombstoneReader;
  caseLawDb: CaseLawPublicReadDb;
  pointers: readonly PassageSourcePointer[];
  countries: readonly string[];
};

const readCitationAdmission = async ({
  caseLawDb,
  pointers,
  countries,
  readTombstones = readCorpusTombstones,
}: DecisionTextGroupOptions) => {
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
  const allowed = new Set(
    pointers
      .filter((pointer) => {
        const current = freshById.get(pointer.id);
        return (
          current?.textWithheldReason === null &&
          current.textEligibilityFingerprint ===
            pointer.textEligibilityFingerprint &&
          decisionPayloadKey(current) === decisionPayloadKey(pointer) &&
          (pointer.astS3Key === null || !tombstones.has(pointer.astS3Key))
        );
      })
      .map(({ id }) => id),
  );
  return { allowed, freshById };
};

type DecisionTextAttemptOptions = DecisionTextGroupOptions & {
  /** Citing decisions whose page rows carry evidence windows; only these read section text eagerly. */
  evidenceDecisionIds: ReadonlySet<string>;
};

type RefreshedPointer = {
  previous: PassageSourcePointer;
  current: PassageSourcePointer;
};

type DecisionTextAttempt = {
  textByDecision: Map<string, DecisionTextRead>;
  /** Pointers whose payload version changed while text was eligible. */
  refreshed: RefreshedPointer[];
};

type VersionedPayloadBatchOptions<K extends DecisionPayloadColumn> = {
  caseLawDb: CaseLawPublicReadDb;
  column: K;
  versions: readonly PassageSourcePointer[];
};

/** Every lazy miss in a bounded group shares one version-qualified read. */
const versionedPayloadBatch = <K extends DecisionPayloadColumn>({
  caseLawDb,
  column,
  versions,
}: VersionedPayloadBatchOptions<K>) => {
  let pending: Promise<Map<string, DecisionPayloadRead<K>>> | undefined;
  return async (pointer: PassageSourcePointer) => {
    pending ??= caseLawDb(
      async (tx) =>
        await readDecisionVersionedPayloads({ tx, versions, column }),
    );
    return (
      (await pending).get(pointer.id) ?? { kind: "version-changed" as const }
    );
  };
};

const readDecisionTextAttempt = async ({
  readTombstones = readCorpusTombstones,
  caseLawDb,
  pointers,
  countries,
  evidenceDecisionIds,
}: DecisionTextAttemptOptions): Promise<DecisionTextAttempt> => {
  const admission = { caseLawDb, pointers, countries, readTombstones };
  const before = await Result.tryPromise(
    async () => await readCitationAdmission(admission),
  );
  if (Result.isError(before)) {
    observeFailure(before.error, {
      sink: citationTextReadFailure,
      ctx: { phase: "admission" },
    });
    return {
      textByDecision: new Map(
        pointers.map(({ id }) => [String(id), UNAVAILABLE_DECISION_TEXT]),
      ),
      refreshed: [],
    };
  }
  // Storage-backed AST hits never start the Postgres AST read.
  const payloadBatch = <K extends DecisionPayloadColumn>(
    column: K,
    versions: readonly PassageSourcePointer[],
  ) => versionedPayloadBatch({ caseLawDb, column, versions });
  const readAst = payloadBatch(
    "documentAst",
    pointers.filter(({ textWithheldReason }) => textWithheldReason === null),
  );
  // Section text is read only where a page row renders evidence from it or
  // the section index misses its cache; each decision's sections are read once.
  const admitted = pointers.filter(({ id }) => before.value.allowed.has(id));
  const readEvidenceSections = payloadBatch(
    "sections",
    admitted.filter(({ id }) => evidenceDecisionIds.has(id)),
  );
  const readIndexSections = payloadBatch(
    "sections",
    admitted.filter(({ id }) => !evidenceDecisionIds.has(id)),
  );
  const readSections = async (pointer: PassageSourcePointer) =>
    evidenceDecisionIds.has(pointer.id)
      ? await readEvidenceSections(pointer)
      : await readIndexSections(pointer);
  const changed = new Set<SafeId<"caseLawDecision">>();
  const entries = await Promise.all(
    pointers.map(async (pointer) => {
      if (
        pointer.textWithheldReason !== null ||
        !before.value.allowed.has(pointer.id)
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
        let evidenceSections: DecisionSection[] | null = null;
        if (evidenceDecisionIds.has(pointer.id)) {
          const evidence = await readEvidenceSections(pointer);
          if (evidence.kind === "version-changed") {
            onVersionChanged();
            return null;
          }
          evidenceSections = evidence.value;
        }
        return changed.has(pointer.id)
          ? null
          : {
              id: pointer.id,
              text: {
                ast,
                language: pointer.language,
                sections,
                evidenceSections,
              },
            };
      });
      if (Result.isError(read)) {
        observeFailure(read.error, {
          sink: citationTextReadFailure,
          ctx: { phase: "payload" },
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
  const after = await Result.tryPromise(
    async () => await readCitationAdmission(admission),
  );
  if (Result.isError(after)) {
    observeFailure(after.error, {
      sink: citationTextReadFailure,
      ctx: { phase: "revalidation" },
    });
  }
  for (const pointer of pointers) {
    if (
      pointer.textWithheldReason === null &&
      (changed.has(pointer.id) ||
        !before.value.allowed.has(pointer.id) ||
        Result.isError(after) ||
        !after.value.allowed.has(pointer.id))
    ) {
      const current = Result.isError(after)
        ? undefined
        : after.value.freshById.get(pointer.id);
      textByDecision.set(
        pointer.id,
        current !== undefined && current.textWithheldReason !== null
          ? {
              type: "source",
              text: null,
              textWithheldReason: current.textWithheldReason,
              extractionWarnings: current.extractionWarnings,
            }
          : UNAVAILABLE_DECISION_TEXT,
      );
    }
  }
  // A newer payload version is admitted again under the policy it carries now.
  const refreshed = Result.isError(after)
    ? []
    : pointers.flatMap((pointer) => {
        const current = after.value.freshById.get(pointer.id);
        return pointer.textWithheldReason === null &&
          current?.textWithheldReason === null &&
          decisionPayloadKey(current) !== decisionPayloadKey(pointer)
          ? [{ previous: pointer, current }]
          : [];
      });
  return { textByDecision, refreshed };
};

type ReadDecisionTextGroupOptions = DecisionTextAttemptOptions & {
  attempt?: number;
};

export const readDecisionTextGroup = async ({
  attempt = 1,
  ...group
}: ReadDecisionTextGroupOptions): Promise<Map<string, DecisionTextRead>> => {
  const { textByDecision, refreshed } = await readDecisionTextAttempt(group);
  if (refreshed.length === 0 || attempt >= PASSAGE_VERSION_ATTEMPTS) {
    return textByDecision;
  }
  const retried = await readDecisionTextGroup({
    ...group,
    pointers: refreshed.map(({ current }) => current),
    // Evidence windows stay bound to the text eligibility the page admitted.
    evidenceDecisionIds: new Set(
      refreshed.flatMap(({ previous, current }) =>
        group.evidenceDecisionIds.has(current.id) &&
        current.textEligibilityFingerprint ===
          previous.textEligibilityFingerprint
          ? [current.id]
          : [],
      ),
    ),
    attempt: attempt + 1,
  });
  for (const [id, text] of retried) {
    textByDecision.set(id, text);
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
  evidenceDecisionIds: ReadonlySet<string>;
};

const readCitationTexts = async ({
  caseLawDb,
  pointers,
  citations,
  countries,
  evidenceDecisionIds,
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
      evidenceDecisionIds,
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
  /** Passage excerpt length; the full allowance when absent. */
  passageChars?: number;
  /**
   * Keeps only rows whose citing paragraph satisfies it. A row with no
   * paragraph to read is dropped too: the filter cannot say it matches.
   */
  passageFilter?: CitationPassageFilter;
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

type DisplayPassageOptions = {
  disposition: CitationTextRead["disposition"] | undefined;
  item: Pick<
    DecisionCitationRow,
    "citationText" | "doctrine" | "evidenceQuote" | "sectionIndex"
  >;
  passageChars: number | undefined;
  passageFilter: CitationPassageFilter | undefined;
};

/** The display passage of an admitted citing text, cut and filtered as asked. */
const displayPassageFor = ({
  disposition,
  item,
  passageChars,
  passageFilter,
}: DisplayPassageOptions): CitationPassage | null => {
  if (
    disposition?.type !== "source" ||
    disposition.text === null ||
    disposition.textWithheldReason !== null
  ) {
    return null;
  }
  const { text } = disposition;
  return citationPassageIn({
    ast: text.ast,
    citationText: item.citationText,
    classifiedBlockIds: sectionBlockIdsAt(text, item.sectionIndex),
    evidenceQuote:
      passageChars === undefined &&
      (item.doctrine === "distinguishes" || item.doctrine === "limits")
        ? item.evidenceQuote
        : null,
    maxChars: passageChars,
    paragraphMatches:
      passageFilter === undefined
        ? undefined
        : (paragraph) => passageFilter(paragraph, text.language),
  });
};

type PreparedDecisionCitations = Awaited<
  ReturnType<typeof prepareDecisionCitations>
>;

type CompleteDecisionCitationsOptions = {
  caseLawDb: CaseLawPublicReadDb;
  prepared: PreparedDecisionCitations;
  /** Passage excerpt length; the full allowance when absent. */
  passageChars?: number | undefined;
  /** Keeps only rows whose citing paragraph satisfies it. */
  passageFilter?: CitationPassageFilter | undefined;
};

/** Resolve both display passages and exact classifier windows through one text owner. */
export const completeDecisionCitations = async ({
  caseLawDb,
  prepared: gated,
  passageChars,
  passageFilter,
}: CompleteDecisionCitationsOptions): Promise<DecisionCitationsRead> => {
  if (
    gated.type === "invalid_cursor" ||
    gated.type === "doctrine_unavailable"
  ) {
    return gated;
  }
  const evidenceByCitation = new Map(
    gated.evidence.type === "ready"
      ? gated.evidence.rows.map((row) => [String(row.id), row] as const)
      : [],
  );
  const resolved = await readCitationTexts({
    caseLawDb,
    pointers: gated.sources,
    countries: gated.countries,
    citations: gated.page.items.map((citation) => ({
      citation,
      citingId: String(citation.printedBy),
    })),
    evidenceDecisionIds: new Set(
      gated.page.items.flatMap((item) =>
        (evidenceByCitation.get(String(item.id))?.evidenceWindows ?? null) ===
        null
          ? []
          : [String(item.printedBy)],
      ),
    ),
  });
  const textByDecision = new Map(
    resolved.map(({ citingId, disposition }) => [citingId, disposition]),
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
    const passage =
      gated.evidence.type === "ready" && evidence === null
        ? null
        : displayPassageFor({ disposition, item, passageChars, passageFilter });
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
      items:
        passageFilter === undefined
          ? items
          : items.filter(({ passage }) => passage !== null),
      nextCursor: gated.page.nextCursor,
      doctrineAvailability: gated.page.doctrineAvailability,
      ...(passageFilter === undefined
        ? {}
        : { scannedCitations: items.length }),
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
    passageChars,
    passageFilter,
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
      : await completeDecisionCitations({
          caseLawDb,
          prepared,
          passageChars,
          passageFilter,
        });
  },
);
