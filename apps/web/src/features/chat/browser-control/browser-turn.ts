import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";

/**
 * The chat turn a browser command belongs to: the user message that started
 * it. The id is the persisted message's, so a runtime rebuilt mid-turn (a
 * reload between an approval and its continuation) keeps charging the same
 * turn. With `toolCallId`, the user message before the assistant message
 * holding that call; without, the latest user message. A regeneration reuses
 * its user message, so it shares that turn's budget.
 */
export const browserTurnId = (
  messages: readonly PersistedChatMessage[],
  toolCallId?: string,
): string | null => {
  const callIndex =
    toolCallId === undefined
      ? -1
      : messages.findIndex(({ parts }) =>
          parts.some(
            (part) => part.type === "tool-call" && part.id === toolCallId,
          ),
        );
  const before = callIndex === -1 ? messages : messages.slice(0, callIndex);
  return before.findLast(({ role }) => role === "user")?.id ?? null;
};

const TRACKED_TURNS = 32;

/**
 * Stop signals by chat turn. Stopping a turn aborts every command of that
 * turn, including one whose approval was already given but whose callback
 * has not run yet; only a later turn gets a live signal.
 */
export const createTurnStopper = () => {
  const controllers = new Map<string, AbortController>();

  const controllerFor = (turnId: string): AbortController => {
    const existing = controllers.get(turnId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AbortController();
    controllers.set(turnId, created);
    // A Map iterates in insertion order, so the first key is the oldest turn.
    if (controllers.size > TRACKED_TURNS) {
      const [oldest] = controllers.keys();
      if (oldest !== undefined) {
        controllers.delete(oldest);
      }
    }
    return created;
  };

  return {
    signalFor: (turnId: string): AbortSignal => controllerFor(turnId).signal,
    stop(turnId: string): void {
      controllerFor(turnId).abort();
    },
  };
};
