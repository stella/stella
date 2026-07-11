import type { TranslationKey } from "@/i18n/types";

export type ReservedChatCommandId = "new" | "model";

// Narrowed to the specific keys in use (still validated against the catalog via
// `Extract`): a broad `TranslationKey` would force `t()`'s interpolation
// overload, since some keys require values, and reject a single-argument call.
type ReservedChatCommandDescriptionKey = Extract<
  TranslationKey,
  "chat.newChat" | "chat.modelSelector.title"
>;

export type ReservedChatCommand = {
  id: ReservedChatCommandId;
  name: string;
  command: string;
  descriptionKey: ReservedChatCommandDescriptionKey;
};

const RESERVED_CHAT_COMMANDS: readonly ReservedChatCommand[] = [
  { id: "new", name: "new", command: "/new", descriptionKey: "chat.newChat" },
  {
    id: "model",
    name: "model",
    command: "/model",
    descriptionKey: "chat.modelSelector.title",
  },
];

// `/model` reuses the dev-only chat model override (`useDevStore.chatModelId`,
// sent as `devModelId`), which the API rejects with a 400 outside dev. Hide it
// from non-dev builds so the command can never be triggered where it would fail.
const DEV_ONLY_COMMAND_IDS: readonly ReservedChatCommandId[] = Object.freeze([
  "model",
]);

export const getReservedChatCommands = (): ReservedChatCommand[] =>
  RESERVED_CHAT_COMMANDS.filter(
    (command) =>
      import.meta.env.DEV || !DEV_ONLY_COMMAND_IDS.includes(command.id),
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
    getReservedChatCommands().find((command) => command.command === text) ??
    null
  );
};
