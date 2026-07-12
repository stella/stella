import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

type TurnBodyItem = {
  message: PersistedChatMessage;
  /** Position in the flat `messages` list, kept so anon-restoration lookups
   *  and retry targeting stay identical to the non-sticky layout. */
  index: number;
};

/**
 * A transcript segment. `user` turns start with a user message that becomes
 * the sticky header; `orphan` turns hold assistant/system messages that
 * precede any user message (e.g. a greeting, or the tail of an older turn
 * pulled in by pagination) and render without a sticky header.
 */
type MessageTurn =
  | {
      type: "user";
      index: number;
      header: PersistedChatMessage;
      body: TurnBodyItem[];
    }
  | { type: "orphan"; body: TurnBodyItem[] };

/**
 * Groups the flat message list into turns for the sticky layout: every user
 * message opens a new turn and the following non-user messages attach to it,
 * so each turn's height spans its whole answer. That height is what gives the
 * sticky header room to pin — a header can only stick within its own turn, so
 * the next turn's header pushes it out as it reaches the top.
 */
export const buildMessageTurns = (
  messages: readonly PersistedChatMessage[],
): MessageTurn[] => {
  const turns: MessageTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "user") {
      turns.push({ type: "user", index, header: message, body: [] });
      continue;
    }
    const last = turns.at(-1);
    if (last) {
      last.body.push({ message, index });
      continue;
    }
    turns.push({ type: "orphan", body: [{ message, index }] });
  }
  return turns;
};
