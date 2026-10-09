import type {
  ChatPart,
  PersistableChatPartType,
} from "@/api/handlers/chat/types";
import type { ChatRefsWritten } from "@/api/lib/chat/ref-registry";

/**
 * Which parts of an assistant message the model wrote, and so may hold a ref
 * it was shown: its text, reasoning and structured output, and each tool
 * call's input. A server tool's output holds the refs the server minted
 * into it. Media holds none, and a tool result mirrors the output of the
 * call it answers, which is read there.
 */
const PART_REFS = {
  activity: "none",
  audio: "none",
  document: "none",
  image: "none",
  "structured-output": "whole",
  // Stella drops TanStack subagent parts at the persistence boundary.
  subagent: "none",
  text: "whole",
  thinking: "whole",
  "tool-call": "tool-call",
  "tool-result": "none",
  "ui-resource": "none",
  video: "none",
} as const satisfies Record<
  PersistableChatPartType,
  "none" | "tool-call" | "whole"
>;

/** The tool-call ids `parts` hold. */
export const toolCallIdsOf = (parts: readonly ChatPart[]): string[] =>
  parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : []));

/**
 * The parts of an assistant message that may hold refs the server showed
 * the model. A client-answered call's output (an ask-user answer, a client
 * tool's result) is what a user or their browser wrote, so it is left out:
 * a ref-shaped token there was never the model's use of a shown ref.
 */
export const chatRefsWrittenIn = ({
  isServerTool,
  parts,
}: {
  isServerTool: (toolName: string) => boolean;
  parts: readonly ChatPart[];
}): ChatRefsWritten => {
  const values: unknown[] = [];
  for (const part of parts) {
    if (PART_REFS[part.type] === "none") {
      continue;
    }
    if (part.type !== "tool-call") {
      values.push(part);
      continue;
    }
    if ("input" in part) {
      values.push(part.input);
    }
    if ("output" in part && isServerTool(part.name)) {
      values.push(part.output);
    }
  }
  return { values };
};
