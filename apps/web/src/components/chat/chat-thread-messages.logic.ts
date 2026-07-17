import type {
  ChatAnonRestoration,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";

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

export const EMPTY_RESTORATION_PAIRS: readonly ChatAnonRestoration[] =
  Object.freeze([]);

/**
 * De-dupe placeholder -> original pairs across multiple parts in a
 * single assistant message so the rehype plugin builds one pattern
 * per stream.
 */
export const collectAnonRestorations = (
  message: PersistedChatMessage,
): readonly ChatAnonRestoration[] => {
  const seen = new Map<string, string>();
  const restorationPairs = message.metadata?.anonRestorations?.pairs;
  if (restorationPairs) {
    for (const pair of restorationPairs) {
      if (!seen.has(pair.placeholder)) {
        seen.set(pair.placeholder, pair.original);
      }
    }
  }
  return [...seen.entries()].map(([placeholder, original]) => ({
    placeholder,
    original,
  }));
};

/**
 * Resolve the restoration pairs that match what *this user message*
 * actually sent: walks forward from a user message's index and uses
 * the first assistant message's server-emitted metadata pairs, which
 * were produced by the same `PipelineContext` the request body
 * crossed. Returns an empty array while the assistant is still
 * streaming, if the turn was sent raw, or if the user message never
 * got a reply — all of these render the user message without pills,
 * matching the audit story (no anonymization -> no audit cue).
 *
 * INVARIANT the walk relies on, mirrored from `buildMessageTurns`:
 * every non-user message between one user message and the next
 * belongs to that user message's turn, and the backend persists at
 * most one assistant message per turn. A retry/regenerate does not
 * append a second assistant message alongside the first — the
 * backend's `replace-last-assistant` persistence plan (see
 * `apps/api/src/handlers/chat/persist-message.ts`) deletes the prior
 * assistant row in place, and the client's `chat.reload()` truncates
 * the live array back to the last user message before streaming a
 * replacement. So the walk MUST stop at the next user message: if it
 * kept going past it, a later turn's assistant reply (or a stray
 * user message left with no reply after a failed/queued send) could
 * get attached to an earlier, unrelated user message.
 */
export const getFollowingAssistantRestorations = (
  messages: readonly PersistedChatMessage[],
  userMessageIndex: number,
): readonly ChatAnonRestoration[] => {
  for (let index = userMessageIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || candidate.role === "user") {
      break;
    }
    if (candidate.role === "assistant") {
      return collectAnonRestorations(candidate);
    }
  }
  return EMPTY_RESTORATION_PAIRS;
};
