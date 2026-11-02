import type { AgentCaseLawSearchWarning } from "../lib/case-law/search-warnings";

/** Agent guidance remains in tool results, never in the human-facing app. */
export const MCP_NOTE_AUDIENCE = {
  input_read: "agent",
  function_words_optional: "agent",
  no_hits: "agent",
  no_hits_filtered: "agent",
  partial_matches_appended: "agent",
  filter_read: "agent",
  filter_dropped: "agent",
  filter_unread: "agent",
  many_required_terms: "agent",
  provision_cited_widely: "agent",
} as const satisfies Record<
  AgentCaseLawSearchWarning["code"] | "input_read",
  "agent" | "user"
>;
