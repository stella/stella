import {
  codeStepResearch,
  type CodeToolResearch,
} from "@stll/api-contract/chat-code-step";

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

/**
 * The title a step shows. A code-mode run names the legal research it does
 * (`codeStepResearch`, shared with the phone); any other step, and a run
 * that reads anything else, keeps its tool's title.
 */
export const getToolCallTitleKey = (call: {
  input: unknown;
  name: string;
  output: unknown;
}): ToolCallTitleKey => {
  const research = codeStepResearch(call);
  return research === undefined
    ? getChatToolTitleKey(call.name)
    : CODE_TOOL_RESEARCH_TITLE_KEYS[research];
};
