import { legalReaderAnswerMessages } from "@/api/db/schema";
import { READER_ANSWER_TRANSITION_IDENTITIES } from "@/api/lib/db/reader-answer-transition-identities";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

// Its own module so the answer handlers depend on this spec alone, not on the
// total registry and every feature's tables behind it.
export const READER_ANSWER_MESSAGE_TRANSITIONS = defineScopedTransitions({
  ...READER_ANSWER_TRANSITION_IDENTITIES.READER_ANSWER_MESSAGE_TRANSITIONS,
  table: legalReaderAnswerMessages,
  edges: { streaming: ["complete", "failed"], complete: [], failed: [] },
  initial: ["streaming", "complete"],
});
