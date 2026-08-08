import type { ReasoningEffort } from "@stll/ai-catalog";

const CLAUDE_FAMILY_PREFIX = /^Claude\s+/u;

export const compactModelDisplayName = (displayName: string): string =>
  displayName.replace(CLAUDE_FAMILY_PREFIX, "");

export const modelSelectionLabel = ({
  defaultEffortLabel,
  displayName,
  reasoningEffort,
  translateEffort,
}: {
  defaultEffortLabel: string;
  displayName: string;
  reasoningEffort: ReasoningEffort | null;
  translateEffort: (effort: ReasoningEffort) => string;
}): string =>
  `${compactModelDisplayName(displayName)} ${
    reasoningEffort === null
      ? defaultEffortLabel
      : translateEffort(reasoningEffort)
  }`;
