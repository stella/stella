import { corpusIndexProjectionIntents } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";
import { CORPUS_INDEX_INTENT_TRANSITIONS } from "@/api/lib/legal-search/corpus-index-projection-contract";

/**
 * The revision lifecycle as the transition owner moves it, from the one graph
 * the contract and the database guard both state. Writers that predate it
 * still move revisions directly.
 */
export const CORPUS_INDEX_PROJECTION_INTENT_LIFECYCLE = defineTransitions(
  corpusIndexProjectionIntents,
  CORPUS_INDEX_INTENT_TRANSITIONS,
  { terminal: ["cancelled"] },
);
