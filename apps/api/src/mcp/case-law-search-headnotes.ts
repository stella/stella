import type * as v from "valibot";

import { truncateDecisionHeadnote } from "../lib/case-law/decision-headnote";
import type { SEARCH_CASE_LAW_PROJECTION } from "../lib/chat/case-law-result-projections";
import { LIMITS } from "../lib/limits";

type SearchPage = Extract<
  v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>,
  { results: unknown }
>;

/** Spend the page's text budget fairly, keeping shorter headnotes whole. */
export const boundCaseLawSearchHeadnotes = (page: SearchPage) => {
  const { results: rows } = page;
  const baseline = JSON.stringify({
    ...page,
    results: rows.map((row) => ({ ...row, headnote: null })),
  }).length;
  // The baseline already paid four characters for each null headnote.
  let remaining =
    LIMITS.mcpCaseLawSearchPageMaxChars - baseline + rows.length * 4;
  const ordered = rows.toSorted(
    (a, b) =>
      JSON.stringify(a.headnote).length - JSON.stringify(b.headnote).length,
  );
  for (const [index, row] of ordered.entries()) {
    const allowance = Math.floor(remaining / (ordered.length - index));
    const headnote = row.headnote;
    if (headnote !== null) {
      const original = headnote.text;
      let low = 1;
      let high = Math.min(original.length, LIMITS.mcpCaseLawHeadnoteMaxChars);
      const bounded = truncateDecisionHeadnote(original, high);
      let fitted = bounded;
      if (
        JSON.stringify({
          ...headnote,
          ...bounded,
          truncated: headnote.truncated || bounded.truncated,
        }).length <= allowance
      ) {
        low = high + 1;
      } else {
        fitted = truncateDecisionHeadnote(original, 1);
      }
      // Count the serialized text too: quotes and control characters take
      // more room in structured content than in the rendered paragraph.
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = truncateDecisionHeadnote(original, middle);
        if (
          JSON.stringify({
            ...headnote,
            ...candidate,
            truncated: headnote.truncated || candidate.truncated,
          }).length <= allowance
        ) {
          fitted = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      row.headnote = {
        type: headnote.type,
        text: fitted.text,
        truncated: headnote.truncated || fitted.truncated,
      };
    }
    remaining -= JSON.stringify(row.headnote).length;
  }
  return page;
};
