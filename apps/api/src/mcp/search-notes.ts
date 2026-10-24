import { panic } from "better-result";

import type { DecisionQueryInterpretation } from "../handlers/case-law/decisions/search-interpretation";
import type { AgentCaseLawSearchWarning } from "../lib/case-law/search-warnings";
import { functionWordsWarning } from "../lib/case-law/search-warnings";
import { MCP_NOTE_AUDIENCE } from "./tool-note-audience";

type SearchWithNotes = {
  warnings: AgentCaseLawSearchWarning[];
};

type SearchNoteRequest = {
  interpretation: Pick<DecisionQueryInterpretation, "droppedFunctionWords">;
};

/** Merge grammar notes across phrasings; keep each distinct corrective note once. */
export const searchNotesForCall = <T extends SearchWithNotes>(
  searches: T[],
  requests: readonly SearchNoteRequest[],
) => {
  const words = [
    ...new Set(
      requests.flatMap(({ interpretation }, index) =>
        (
          searches.at(index) ?? panic("Search note request has no result")
        ).warnings.some(({ code }) => code === "function_words_optional")
          ? interpretation.droppedFunctionWords
          : [],
      ),
    ),
  ];
  const seen = new Set<string>();
  return searches.map((search, index) => {
    const notes = search.warnings.filter(
      ({ code }) => code !== "function_words_optional",
    );
    if (index === 0 && words.length > 0) {
      notes.unshift(functionWordsWarning(words));
    }
    return {
      ...search,
      warnings: notes
        .filter(({ code, message, hint }) => {
          const key = JSON.stringify([code, message, hint]);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .map((note) => ({ ...note, audience: MCP_NOTE_AUDIENCE[note.code] })),
    };
  });
};
