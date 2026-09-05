import { panic } from "better-result";

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
      return panic(`Unhandled id: ${String(id)}`);
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

export type ReservedChatCommandMatch = {
  command: ReservedChatCommand;
  /** Text after the command token, trimmed; "" when the command is bare. */
  args: string;
};

// Compares the composer's HTML against a reserved command. `DOMParser` decodes
// entities and strips tags safely; a single-pass tag-stripping regex is an
// incomplete sanitizer (CodeQL js/incomplete-multi-character-sanitization) and
// can leave partial markup behind.
//
// A command with trailing text (`/rename-chat Quarterly review`) matches too,
// with the remainder as `args`: a draft that *starts* with a reserved command
// is an invocation, and letting it fall through would send it to the model as
// literal prompt text. The token boundary is strict — `/newest` is a prompt,
// not `/new` — and a command mentioned mid-sentence never matches.
export const matchReservedChatCommand = (
  html: string,
): ReservedChatCommandMatch | null => {
  const text = new DOMParser()
    .parseFromString(html, "text/html")
    .body.textContent.trim();
  for (const command of RESERVED_CHAT_COMMANDS) {
    if (text === command.command) {
      return { command, args: "" };
    }
    const rest = text.slice(command.command.length);
    if (text.startsWith(command.command) && /^\s/u.test(rest)) {
      return { command, args: rest.trim() };
    }
  }
  return null;
};

/**
 * One handler per reserved command id — a total record, so adding an id
 * fails to compile at every composer until it declares a disposition. This
 * is what keeps a new command from silently reaching the model as literal
 * prompt text on a composer that forgot to handle it. Handlers receive the
 * command's trailing text ("" when bare) and decide what it means.
 */
export type ReservedChatCommandHandlers = Record<
  ReservedChatCommandId,
  (args: string) => void
>;

/**
 * Called on submit with the chat input's not-yet-sent content (as the rich
 * editor's HTML), before anything is sent to the model. Returns true when
 * the content is a reserved command: its handler has run and the text must
 * not be sent. Returns false when it is an ordinary message the caller
 * should send to the model as usual.
 */
export const runReservedChatCommand = (
  html: string,
  handlers: ReservedChatCommandHandlers,
): boolean => {
  const match = matchReservedChatCommand(html);
  if (!match) {
    return false;
  }
  handlers[match.command.id](match.args);
  return true;
};
