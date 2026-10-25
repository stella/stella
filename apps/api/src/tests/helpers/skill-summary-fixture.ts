import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { ChatMessage } from "@/api/handlers/chat/types";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";

export const SKILL_SUMMARY_SECRET = "SKILL SUMMARY PRIVATE INSTRUCTIONS";

type SkillSummaryMessageOptions = {
  id: SafeId<"chatMessage">;
  instructions?: string;
  skillId?: SafeId<"agentSkill">;
};

export const skillSummaryMessage = ({
  id,
  instructions = SKILL_SUMMARY_SECRET,
  skillId = toSafeId<"agentSkill">("00000000-0000-4000-8000-0000000000dd"),
}: SkillSummaryMessageOptions) => {
  const skillOutput = {
    contentHash: "a".repeat(64),
    description: "Summary boundary fixture",
    instructions,
    name: "summary-fixture",
    resources: [],
    skillId,
    version: null,
  };
  const ordinaryOutput = { outcome: "ORDINARY OUTCOME" };
  return {
    id,
    role: "assistant",
    parts: [
      { type: "text", content: "ORDINARY CONVERSATION" },
      {
        type: "tool-call",
        id: `${id}-skill`,
        name: "load-skill",
        arguments: JSON.stringify({ skillName: skillOutput.name }),
        input: { skillName: skillOutput.name },
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
        output: skillOutput,
        state: "complete",
      },
      {
        type: "tool-result",
        toolCallId: `${id}-skill`,
        content: JSON.stringify(skillOutput),
        state: "complete",
      },
      {
        type: "tool-call",
        id: `${id}-ordinary`,
        name: "mcp__fixture__ordinary_lookup",
        arguments: "{}",
        input: {},
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
        output: ordinaryOutput,
        state: "complete",
      },
      {
        type: "tool-result",
        toolCallId: `${id}-ordinary`,
        content: JSON.stringify(ordinaryOutput),
        state: "complete",
      },
    ],
  } satisfies ChatMessage;
};
