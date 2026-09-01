import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import { LIMITS } from "@/api/lib/limits";

const KEYWORD_SEPARATOR = " · ";
const ELLIPSIS = "…";
/** Cut on a word boundary only when that keeps most of the budget. */
const WORD_BOUNDARY_MIN_RATIO = 0.6;

/**
 * The one line a lawyer recognises a decision by, from what publishers
 * supply: the court's own legal sentence, an abstract, the keyword chain,
 * or at least the area of law. First non-empty wins; the order is from the
 * most to the least specific, and it is the same for every source so a row's
 * second line means the same thing across courts.
 */
export const decisionHeadnoteSql = (metadata: SQLWrapper): SQL<string | null> =>
  sql<string | null>`coalesce(
    nullif(btrim(${metadata} ->> 'legalSentence'), ''),
    nullif(btrim(${metadata} ->> 'abstract'), ''),
    nullif(
      (
        SELECT string_agg(keyword.value, ${KEYWORD_SEPARATOR} ORDER BY keyword.ordinality)
        FROM jsonb_array_elements_text(
          CASE jsonb_typeof(${metadata} -> 'keywords')
            WHEN 'array' THEN ${metadata} -> 'keywords'
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS keyword(value, ordinality)
      ),
      ''
    ),
    nullif(btrim(${metadata} ->> 'legalArea'), '')
  )`;

/**
 * Publisher text as one bounded line: whitespace runs collapsed, then cut
 * to the row budget on a word boundary. Null when there is nothing to show,
 * so the row can omit the line rather than render an empty one.
 */
export const normalizeDecisionHeadnote = (raw: unknown): string | null => {
  if (typeof raw !== "string") {
    return null;
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  const max = LIMITS.caseLawHeadnoteMaxChars;
  if (collapsed.length <= max) {
    return collapsed;
  }
  const budget = max - ELLIPSIS.length;
  // A cut inside a surrogate pair would leave a lone high surrogate before
  // the mark: back off one code unit when the budget lands there.
  const cut16 = collapsed.slice(0, budget);
  const head = /[\uD800-\uDBFF]$/u.test(cut16) ? cut16.slice(0, -1) : cut16;
  const lastSpace = head.lastIndexOf(" ");
  const cut =
    lastSpace >= Math.floor(budget * WORD_BOUNDARY_MIN_RATIO)
      ? head.slice(0, lastSpace)
      : head;
  return `${cut.trimEnd()}${ELLIPSIS}`;
};
