import type {
  ChatPart,
  PersistableChatPartType,
} from "@/api/handlers/chat/types";
import type { ChatRefsShown } from "@/api/lib/chat/ref-registry";

/**
 * Which parts show the model refs. Tool outputs carry the refs a server tool
 * minted; text carries the ref links the assistant wrote. Everything else is
 * model-authored reasoning or data, or media, which shows no ref the server
 * minted.
 */
const PART_SHOWS_REFS = {
  audio: "none",
  document: "none",
  image: "none",
  "structured-output": "none",
  text: "text",
  thinking: "none",
  "tool-call": "tool-output",
  // Mirrors the output of the call it answers, which is read there.
  "tool-result": "none",
  "ui-resource": "none",
  video: "none",
} as const satisfies Record<
  PersistableChatPartType,
  "none" | "text" | "tool-output"
>;

/**
 * Where an assistant message's parts showed the model refs. A
 * client-answered call's output (an ask-user answer, a client tool's result)
 * is what a user or their browser wrote, so a ref-shaped token in it was
 * never shown by the server and is left out.
 */
export const chatRefsShownIn = ({
  isServerTool,
  parts,
}: {
  isServerTool: (toolName: string) => boolean;
  parts: readonly ChatPart[];
}): ChatRefsShown => {
  const outputs: unknown[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    if (PART_SHOWS_REFS[part.type] === "none") {
      continue;
    }
    if (part.type === "text") {
      texts.push(part.content);
    } else if (
      part.type === "tool-call" &&
      "output" in part &&
      isServerTool(part.name)
    ) {
      outputs.push(part.output);
    }
  }
  return { outputs, texts };
};
