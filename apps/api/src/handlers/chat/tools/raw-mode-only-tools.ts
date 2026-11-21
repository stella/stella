import type { BuiltInChatToolPolicyKindByName } from "@stll/api-contract";

/**
 * Tools chat offers only in raw mode. Counterparty findings name natural
 * persons with birth dates and identifiers the anonymization boundary cannot
 * redact, and the folder consistency review sends the selected documents to
 * the model without that boundary. The anonymized boundary drops their stored
 * calls and results too, so a thread that switches modes does not replay them.
 */
export const RAW_MODE_ONLY_CHAT_TOOL_NAMES = [
  "counterparty_check",
  "review_folder_consistency",
  "request_secret",
  "use_connector_secret",
] as const satisfies readonly (keyof BuiltInChatToolPolicyKindByName)[];

export type RawModeOnlyChatToolName =
  (typeof RAW_MODE_ONLY_CHAT_TOOL_NAMES)[number];

const RAW_MODE_ONLY = new Set<string>(RAW_MODE_ONLY_CHAT_TOOL_NAMES);

export const isRawModeOnlyChatTool = (name: string): boolean =>
  RAW_MODE_ONLY.has(name);
