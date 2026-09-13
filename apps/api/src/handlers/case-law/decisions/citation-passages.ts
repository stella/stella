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
 * open, so the shape here mirrors `readGatedDecisionWithDocument`: gate and
 * read every row inside one transaction, then resolve passages once it has
 * closed.
 */

import { Result } from "better-result";
import { eq, inArray } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { DecisionCitationRow } from "@/api/handlers/case-law/decisions/citation-graph";
import { listDecisionCitationsHandler } from "@/api/handlers/case-law/decisions/citation-graph";
import { withRedistributableSubject } from "@/api/handlers/case-law/decisions/public-subject";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CitationReadDirection } from "@/api/lib/case-law/citation-vocabulary";
import { GRAPH_DIRECTION } from "@/api/lib/case-law/citation-vocabulary";
import { readDecisionAnalysisAst } from "@/api/lib/case-law/decision-analysis";
import { errorTag } from "@/api/lib/errors/utils";
import { allowsDerivedAi } from "@/api/lib/legal-search/corpus-source";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";

/** The paragraph an agent is given per citation, and its deep-link anchor. */
export type CitationPassage = {
  anchorId: string;
  text: string;
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
const PASSAGE_AST_CONCURRENCY = LIMITS.caseLawCitationPassageConcurrency;

/**
 * What a passage read needs about the decision whose text it comes from.
 *
 * `documentAst` is the row's own copy, and it is read for the fallback path
 * alone: a canonical row's column is trimmed and the object is the document.
 * Under `corpusStorageMode: "off"` the column IS the document, so a page of
 * incoming citations reads up to `limit` whole ASTs out of Postgres; that is
 * the mode's cost, and the page size is the bound on it.
 */
type PassageSourceRow = {
  id: SafeId<"caseLawDecision">;
  astS3Key: string | null;
  contentHash: string | null;
  documentAst: unknown;
};

const readPassageSourceRows = async (
  tx: CaseLawPublicReadTransaction,
  ids: readonly SafeId<"caseLawDecision">[],
): Promise<PassageSourceRow[]> => {
  if (ids.length === 0) {
    return [];
  }
  const rows = await tx
    .select({
      id: caseLawDecisions.id,
      astS3Key: caseLawDecisions.astS3Key,
      contentHash: caseLawDecisions.contentHash,
      documentAst: caseLawDecisions.documentAst,
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

const WHITESPACE_RUN = /\s+/gu;

/**
 * Both sides of the match are flattened the same way. A citation is stored as
 * the document printed it, line wrap included, while a block's `plainText` is
 * the AST's own flattening, so comparing the two verbatim misses exactly the
 * citations that were broken across lines.
 */
const collapseWhitespace = (text: string): string =>
  text.replace(WHITESPACE_RUN, " ").trim();

const excerptAround = (text: string, at: number, length: number): string => {
  if (text.length <= PASSAGE_MAX_CHARS) {
    return text;
  }
  const margin = Math.max(0, Math.floor((PASSAGE_MAX_CHARS - length) / 2));
  const start = Math.max(
    0,
    Math.min(at - margin, text.length - PASSAGE_MAX_CHARS),
  );
  return text.slice(start, start + PASSAGE_MAX_CHARS);
};

/**
 * The block that carries a citation, latest first.
 *
 * A case is commonly listed bare in the header and then discussed in the
 * reasoning, and the discussion is what was asked for. The extractor records
 * the later section for the same reason, so both sides prefer one mention.
 */
export const citationPassageIn = (
  ast: DocumentAst,
  citationText: string,
): CitationPassage | null => {
  const needle = collapseWhitespace(citationText);
  if (needle.length === 0) {
    return null;
  }
  for (let index = ast.blocks.length - 1; index >= 0; index -= 1) {
    const block = ast.blocks[index];
    if (block === undefined) {
      continue;
    }
    const text = collapseWhitespace(block.plainText);
    const at = text.indexOf(needle);
    if (at === -1) {
      continue;
    }
    return {
      anchorId: block.anchorId,
      text: excerptAround(text, at, needle.length),
    };
  }
  return null;
};

/**
 * One AST read per distinct decision, bounded. An object that cannot be read
 * costs its rows their passage, never the page: the citation and the decision
 * it names are still the answer to what the court cited.
 */
const readAstsByDecision = async (
  sources: readonly PassageSourceRow[],
): Promise<Map<string, DocumentAst>> => {
  const entries = await mapWithConcurrency({
    items: sources,
    limit: PASSAGE_AST_CONCURRENCY,
    operation: async (source) => {
      const read = await Result.tryPromise(
        async () => await readDecisionAnalysisAst(source),
      );
      if (Result.isError(read)) {
        logger.warn("case_law.citation_passage.ast_unavailable", {
          "error.type": errorTag(read.error),
        });
        return null;
      }
      return read.value === null ? null : { ast: read.value, id: source.id };
    },
  });
  return new Map(
    entries.flatMap((entry) =>
      entry === null ? [] : [[String(entry.id), entry.ast] as const],
    ),
  );
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
        sources: await readPassageSourceRows(subject.tx, citingIds),
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

  const astByDecision = await readAstsByDecision(gated.sources);
  const items = gated.page.items.map((item): CitationWithPassage => {
    const citingId =
      direction === "cites" ? String(decisionId) : String(item.decision?.id);
    const ast = astByDecision.get(citingId);
    return {
      ...item,
      passage:
        ast === undefined ? null : citationPassageIn(ast, item.citationText),
    };
  });

  return {
    page: { items, nextCursor: gated.page.nextCursor },
    type: "page",
  };
};
