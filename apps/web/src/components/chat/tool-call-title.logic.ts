import {
  codeStepResearch,
  type CodeToolResearch,
} from "@stll/api-contract/chat-code-step";
import { CHAT_LOCAL_RUN_TOOL_NAMES } from "@stll/api-contract/chat-local-run-tool";
import {
  chatToolLabel,
  UNKNOWN_CHAT_TOOL_LABEL,
} from "@stll/api-contract/chat-tool-activity";
import { humanizeIdentifier } from "@stll/api-contract/chat-tool-input-rows";

import { getChatToolTitleKey } from "@/components/chat/chat-ui-tools";
import type { TranslationKey } from "@/i18n/types";

const CODE_TOOL_RESEARCH_TITLE_KEYS = {
  caseLaw: "chat.toolCall.searchingCaseLaw",
  legislation: "chat.toolCall.readingLegislation",
  legislationAndCaseLaw: "chat.toolCall.searchingLegislationAndCaseLaw",
} as const satisfies Record<CodeToolResearch, TranslationKey>;

export type ToolCallTitleKey =
  | ReturnType<typeof getChatToolTitleKey>
  | (typeof CODE_TOOL_RESEARCH_TITLE_KEYS)[CodeToolResearch];

type ToolCall = {
  input: unknown;
  name: string;
  output: unknown;
};

/**
 * The title key a step shows. A code-mode run, or a coding agent's direct
 * call to a stella read, names the legal research it does
 * (`codeStepResearch`, shared with the phone); any other step keeps its
 * tool's title.
 */
export const getToolCallTitleKey = (call: ToolCall): ToolCallTitleKey => {
  const research = codeStepResearch(call);
  return research === undefined
    ? getChatToolTitleKey(call.name)
    : CODE_TOOL_RESEARCH_TITLE_KEYS[research];
};

/**
 * A step's title: a catalogue key, or, for a tool stella keeps no title for
 * (a connector a coding agent's own configuration adds, a stella tool the
 * chat does not register), the tool's own name. A generic "Using tool" says
 * nothing about which of several steps is which.
 */
export type ToolCallTitle =
  { type: "key"; key: ToolCallTitleKey } | { type: "name"; name: string };

/** `mcp__<server>__<tool>` names its tool by the part after the server. */
const ownToolName = (name: string): string =>
  name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name;

export const getToolCallTitle = (call: ToolCall): ToolCallTitle => {
  const key = getToolCallTitleKey(call);
  // A coding agent's own step keeps the generic title: its row names the
  // harness tool beneath it (`localRunToolView`).
  if (
    chatToolLabel(call.name) !== UNKNOWN_CHAT_TOOL_LABEL ||
    key !== getChatToolTitleKey(call.name) ||
    call.name === CHAT_LOCAL_RUN_TOOL_NAMES.nativeTool
  ) {
    return { type: "key", key };
  }
  const name = humanizeIdentifier(ownToolName(call.name));
  return name === "" ? { type: "key", key } : { type: "name", name };
};

/** A title as text: its key translated, or the tool's own name as is. */
export const toolCallTitleText = <TKey extends string>(
  title: { type: "key"; key: TKey } | { type: "name"; name: string },
  t: (key: TKey) => string,
): string => (title.type === "key" ? t(title.key) : title.name);
