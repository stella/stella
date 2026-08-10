import type { ReasoningEffort } from "@stll/ai-catalog";

const CLAUDE_FAMILY_PREFIX = /^Claude\s+/u;

export const compactModelDisplayName = (displayName: string): string =>
  displayName.replace(CLAUDE_FAMILY_PREFIX, "");

const EFFORT_SECTION = {
  none: "standard",
  minimal: "standard",
  low: "standard",
  medium: "standard",
  high: "standard",
  xhigh: "extended",
  max: "extended",
} as const satisfies Record<ReasoningEffort, "extended" | "standard">;

export const groupReasoningEfforts = (
  efforts: readonly ReasoningEffort[],
): {
  extended: ReasoningEffort[];
  standard: ReasoningEffort[];
} => {
  const standard: ReasoningEffort[] = [];
  const extended: ReasoningEffort[] = [];
  for (const effort of efforts) {
    if (EFFORT_SECTION[effort] === "extended") {
      extended.push(effort);
    } else {
      standard.push(effort);
    }
  }
  return { extended, standard };
};

export const modelSelectionLabel = ({
  defaultEffortLabel,
  displayName,
  formatSelectionLabel,
  providerDefaultEffort,
  reasoningEffort,
  translateEffort,
}: {
  defaultEffortLabel: string;
  displayName: string;
  formatSelectionLabel: (values: { effort: string; model: string }) => string;
  providerDefaultEffort: ReasoningEffort | null;
  reasoningEffort: ReasoningEffort | null;
  translateEffort: (effort: ReasoningEffort) => string;
}): string => {
  const effectiveEffort = reasoningEffort ?? providerDefaultEffort;
  return formatSelectionLabel({
    effort:
      effectiveEffort === null
        ? defaultEffortLabel
        : translateEffort(effectiveEffort),
    model: compactModelDisplayName(displayName),
  });
};
