import type { TimeEntrySuggestionEvidence } from "@stll/api-contract/time-entry-types";

export type SuggestionCopyLabels = {
  chatEvidence: (messageCount: number, title: string) => string;
  unnamedRecord: string;
};

const NARRATIVE_SEPARATOR = "; ";

/**
 * One short label per piece of evidence, in the order the day produced it:
 * the conversation with its message count, or the record's name.
 */
export const suggestionEvidenceLabels = (
  evidence: readonly TimeEntrySuggestionEvidence[],
  labels: SuggestionCopyLabels,
): string[] =>
  evidence.map((item) =>
    item.type === "chat_thread"
      ? labels.chatEvidence(item.messageCount, item.title)
      : (item.name ?? labels.unnamedRecord),
  );

/**
 * The narrative a suggestion is accepted with unless the timekeeper edits it:
 * every distinct conversation title and record name, joined. Counts and
 * actions stay out of it; a narrative names the work, not the telemetry.
 */
export const composeSuggestionNarrative = (
  evidence: readonly TimeEntrySuggestionEvidence[],
  labels: Pick<SuggestionCopyLabels, "unnamedRecord">,
): string => {
  const parts: string[] = [];
  for (const item of evidence) {
    const part =
      item.type === "chat_thread"
        ? item.title.trim()
        : (item.name?.trim() ?? "");
    const resolved = part.length > 0 ? part : labels.unnamedRecord;
    if (!parts.includes(resolved)) {
      parts.push(resolved);
    }
  }
  return parts.join(NARRATIVE_SEPARATOR);
};
