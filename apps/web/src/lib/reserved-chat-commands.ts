import type { TranslationKey } from "@/i18n/types";

// Narrowed to the specific keys in use (still validated against the catalog via
// `Extract`): a broad `TranslationKey` would force `t()`'s interpolation
// overload, since some keys require values, and reject a single-argument call.
type ReservedChatCommandDescriptionKey = Extract<
  TranslationKey,
  "chat.newChat" | "chat.renameThread"
>;

const RESERVED_CHAT_COMMANDS = [
  { id: "new", name: "new", command: "/new", descriptionKey: "chat.newChat" },
  {
    id: "rename-chat",
    name: "rename-chat",
    command: "/rename-chat",
    descriptionKey: "chat.renameThread",
  },
] as const satisfies readonly {
  id: string;
  name: string;
  command: string;
  descriptionKey: ReservedChatCommandDescriptionKey;
}[];

export type ReservedChatCommand = (typeof RESERVED_CHAT_COMMANDS)[number];
export type ReservedChatCommandId = ReservedChatCommand["id"];

export type ReservedChatCommandContext = {
  /**
   * Whether the composer is bound to a thread persisted on the server (it
   * has at least one message). `/rename-chat` is offered only there: an
   * unsent draft thread has nothing to rename or summarize.
   */
  hasPersistedThread: boolean;
};

const isReservedChatCommandOffered = (
  id: ReservedChatCommandId,
  context: ReservedChatCommandContext,
): boolean => {
  switch (id) {
    case "new":
      return true;
    case "rename-chat":
      return context.hasPersistedThread;
    default:
      id satisfies never;
      return false;
  }
};

/**
 * The reserved commands to offer in a chat composer's slash menu. Availability
 * is declared here, centrally, so no surface decides on its own which
 * commands exist. Matching (below) deliberately ignores availability: a
 * command typed by hand where it is not offered still reaches its declared
 * handler, which explains itself, instead of being sent to the model.
 */
export const getReservedChatCommands = (
  context: ReservedChatCommandContext,
): ReservedChatCommand[] =>
  RESERVED_CHAT_COMMANDS.filter((command) =>
    isReservedChatCommandOffered(command.id, context),
  );

// Compares the composer's HTML against a reserved command. `DOMParser` decodes
// entities and strips tags safely; a single-pass tag-stripping regex is an
// incomplete sanitizer (CodeQL js/incomplete-multi-character-sanitization) and
// can leave partial markup behind.
export const matchReservedChatCommand = (
  html: string,
): ReservedChatCommand | null => {
  const text = new DOMParser()
    .parseFromString(html, "text/html")
    .body.textContent.trim();
  return (
    RESERVED_CHAT_COMMANDS.find((command) => command.command === text) ?? null
  );
};

/**
 * One handler per reserved command id — a total record, so adding an id
 * fails to compile at every composer until it declares a disposition. This
 * is what keeps a new command from silently reaching the model as literal
 * prompt text on a composer that forgot to handle it.
 */
export type ReservedChatCommandHandlers = Record<
  ReservedChatCommandId,
  () => void
>;

/**
 * Dispatches the composer draft against the reserved commands. Returns true
 * when a command matched and its handler ran; false means the draft is an
 * ordinary prompt the composer should send to the model.
 */
export const runReservedChatCommand = (
  html: string,
  handlers: ReservedChatCommandHandlers,
): boolean => {
  const command = matchReservedChatCommand(html);
  if (!command) {
    return false;
  }
  handlers[command.id]();
  return true;
};
