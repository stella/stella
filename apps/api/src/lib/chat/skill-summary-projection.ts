import { SKILL_CONTENT_TOOL_NAMES } from "@/api/lib/agent-skills/skill-content-tools";
import { assertToolResultsHaveCalls } from "@/api/lib/chat/tool-history-pairing";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Skill payloads are current execution context, never durable summary text.
 * The full batch identifies paired results even across the summary boundary.
 */
export const createSkillSummaryProjection = (
  messageParts: readonly (readonly unknown[])[],
) => {
  assertToolResultsHaveCalls(messageParts);
  const skillCallIds = new Set<string>();
  for (const parts of messageParts) {
    for (const part of parts) {
      if (
        isRecord(part) &&
        part["type"] === "tool-call" &&
        typeof part["id"] === "string" &&
        SKILL_CONTENT_TOOL_NAMES.some((name) => name === part["name"])
      ) {
        skillCallIds.add(part["id"]);
      }
    }
  }
  const parts = <T>(summaryParts: readonly T[]): T[] =>
    summaryParts.filter((part) => {
      if (!isRecord(part)) {
        return true;
      }
      switch (part["type"]) {
        case "tool-call":
          return (
            typeof part["id"] !== "string" || !skillCallIds.has(part["id"])
          );
        case "tool-result":
          return (
            typeof part["toolCallId"] !== "string" ||
            !skillCallIds.has(part["toolCallId"])
          );
        default:
          return true;
      }
    });
  return {
    includesToolCall: (id: string) => !skillCallIds.has(id),
    parts,
  };
};
