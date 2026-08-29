import type { ChangeEvent } from "react";

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { ChatModelOption, ChatModelSelection } from "./runtime";
import { ChatConfigurationError } from "./runtime";

const CLAUDE_FAMILY_PREFIX = /^Claude\s+/u;

export const compactModelDisplayName = (displayName: string): string =>
  displayName.replace(CLAUDE_FAMILY_PREFIX, "");

const effortSection = {
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
): { extended: ReasoningEffort[]; standard: ReasoningEffort[] } => {
  const standard: ReasoningEffort[] = [];
  const extended: ReasoningEffort[] = [];
  for (const effort of efforts) {
    if (effortSection[effort] === "extended") {
      extended.push(effort);
      continue;
    }
    standard.push(effort);
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

export type ChatModelSelectorProps = {
  autoLabel: string;
  disabled?: boolean | undefined;
  label: string;
  onSelectionChange: (selection: ChatModelSelection) => void;
  options: readonly ChatModelOption[];
  selection: ChatModelSelection;
};

const toValue = ({ modelId, provider }: ChatModelSelection): string =>
  modelId === null || provider === null ? "" : `${provider}:${modelId}`;

const parseSelection = (
  value: string,
  options: readonly ChatModelOption[],
): ChatModelSelection => {
  if (value.length === 0) {
    return { modelId: null, provider: null, reasoningEffort: null };
  }
  const option = options.find(
    (candidate) => `${candidate.provider}:${candidate.modelId}` === value,
  );
  if (option === undefined) {
    throw new ChatConfigurationError({
      code: "unconfigured-model",
      message: `Selected AI model is not available: ${value}.`,
      modelId: value,
    });
  }
  return {
    modelId: option.modelId,
    provider: option.provider,
    reasoningEffort: null,
  };
};

/** Native, accessible model control. Provider configuration is validated by
 * `resolveChatModelSelection` before a host accepts the new selection. */
export const ChatModelSelector = ({
  autoLabel,
  disabled = false,
  label,
  onSelectionChange,
  options,
  selection,
}: ChatModelSelectorProps) => {
  const onChange = ({ currentTarget }: ChangeEvent<HTMLSelectElement>) => {
    onSelectionChange(parseSelection(currentTarget.value, options));
  };
  return (
    <select
      aria-label={label}
      disabled={disabled}
      onChange={onChange}
      value={toValue(selection)}
    >
      <option value="">{autoLabel}</option>
      {options.map((option) => (
        <option
          key={`${option.provider}:${option.modelId}`}
          value={`${option.provider}:${option.modelId}`}
        >
          {option.displayName}
        </option>
      ))}
    </select>
  );
};
