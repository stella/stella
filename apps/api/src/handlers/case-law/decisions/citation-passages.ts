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

import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";

import { findCitationPassage } from "@stll/legal-ast/citation-passage";
import type { CitationPassageMention } from "@stll/legal-ast/citation-passage";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { DecisionCitationRow } from "@/api/handlers/case-law/decisions/citation-graph";
import { listDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CitationReadDirection } from "@/api/lib/case-law/citation-vocabulary";
import { GRAPH_DIRECTION } from "@/api/lib/case-law/citation-vocabulary";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { chunked } from "@/api/lib/chunked";
import { errorTag } from "@/api/lib/errors/utils";
import { readCorpusTombstones } from "@/api/lib/legal-search/corpus-reads";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/** The paragraph an agent is given per citation, and its deep-link anchor. */
export type CitationPassage = {
  anchorId: string;
  /** An excerpt, not the block, whenever `truncated` is true. */
  text: string;
  truncated: boolean;
  mention: CitationPassageMention;
};

export type CitationWithPassage = DecisionCitationRow & {
  /**
   * The citing block, or null where there is none to give: the source bars
   * derived AI use, the decision's document is not parsed, its object could
   * not be read, or no block carries the citation's text.
   */
  passage: CitationPassage | null;
};

export type DecisionCitationsPage = {
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
};

const readPassageSourcePointers = async (
  tx: CaseLawPublicReadTransaction,
  ids: readonly SafeId<"caseLawDecision">[],
): Promise<PassageSourcePointer[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      id: caseLawDecisions.id,
      astS3Key: caseLawDecisions.astS3Key,
      contentHash: caseLawDecisions.contentHash,
      descriptor: caseLawSources.descriptor,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(inArray(caseLawDecisions.id, [...ids]));
  // The same split the decision read makes: redistribution decides whether a
  // citation may be listed at all, derived AI whether its text may travel
  // with it.
  return rows.flatMap(({ descriptor, ...row }) =>
    allowsDerivedAi(descriptor) ? [row] : [],
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
  documentAst: unknown;
  sections: DecisionSection[] | null;
};

const readDecisionTextColumns = async (
  caseLawDb: CaseLawPublicReadDb,
  ids: readonly SafeId<"caseLawDecision">[],
): Promise<Map<string, DecisionTextColumns>> => {
  const rows = await caseLawDb(
    async (tx) =>
      await tx
        .select({
          id: caseLawDecisions.id,
          documentAst: caseLawDecisions.documentAst,
          sections: caseLawDecisions.sections,
        })
        .from(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, [...ids])),
  );
  return new Map(
    rows.map(({ id, ...columns }) => [String(id), columns] as const),
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
}: CitationPassageOptions): CitationPassage | null => {
  const match = findCitationPassage({
    blocks: ast.blocks,
    citationText,
    sectionText,
  });
  if (match === null) {
    return null;
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
  };
};

/** A citing decision's text, as a passage read needs to see it. */
type DecisionText = {
  ast: DocumentAst;
  sections: DecisionSection[] | null;
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
 * read costs its rows their passage, never the page: the citation and the
 * decision it names are still the answer to what the court cited.
 */
const readDecisionTextByDecision = async (
  caseLawDb: CaseLawPublicReadDb,
  pointers: readonly PassageSourcePointer[],
): Promise<Map<string, DecisionText>> => {
  const textByDecision = new Map<string, DecisionText>();
  for (const group of chunked(pointers, PASSAGE_AST_GROUP_SIZE)) {
    const columns = await readDecisionTextColumns(
      caseLawDb,
      group.map((pointer) => pointer.id),
    );
    const entries = await Promise.all(
      group.map(async (pointer) => {
        const row = columns.get(String(pointer.id));
        const read = await Result.tryPromise(
          async () =>
            await readDecisionAnalysisAst(
              { ...pointer, documentAst: row?.documentAst ?? null },
              readCorpusTombstones,
            ),
        );
        if (Result.isError(read)) {
          logger.warn("case_law.citation_passage.ast_unavailable", {
            "error.type": errorTag(read.error),
          });
          return null;
        }
        return read.value === null
          ? null
          : {
              id: pointer.id,
              text: { ast: read.value, sections: row?.sections ?? null },
            };
      }),
    );
    for (const entry of entries) {
      if (entry !== null) {
        textByDecision.set(String(entry.id), entry.text);
      }
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
};

/**
 * One page of a decision's citations, each with the paragraph that made it.
 *
 * Null is the publication gate's answer: no such decision for the public, or
 * its source may not be redistributed.
 */
export const readGatedDecisionCitations = async ({
  caseLawDb,
  cursor,
  decisionId,
  direction,
  limit,
}: ReadDecisionCitationsOptions): Promise<DecisionCitationsRead | null> => {
  const gated = await withRedistributableSubject(
    caseLawDb,
    { kind: "id", id: decisionId },
    async (subject) => {
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
      return {
        page,
        sources: await readPassageSourcePointers(subject.tx, citingIds),
        type: "page" as const,
      };
    },
  );
  if (gated === null) {
    return null;
  }
  if (gated.type === "invalid_cursor") {
    return gated;
  }

  const textByDecision = await readDecisionTextByDecision(
    caseLawDb,
    gated.sources,
  );
  const items = gated.page.items.map((item): CitationWithPassage => {
    const citingId =
      direction === "cites" ? String(decisionId) : String(item.decision?.id);
    const text = textByDecision.get(citingId);
    return {
      ...item,
      passage:
        text === undefined
          ? null
          : citationPassageIn({
              ast: text.ast,
              citationText: item.citationText,
              sectionText: sectionTextAt(text.sections, item.sectionIndex),
            }),
    };
  });

  return {
    page: { items, nextCursor: gated.page.nextCursor },
    type: "page",
  };
};
