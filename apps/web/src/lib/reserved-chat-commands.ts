import type { TranslationKey } from "@/i18n/types";

// Narrowed to the specific keys in use (still validated against the catalog via
// `Extract`): a broad `TranslationKey` would force `t()`'s interpolation
// overload, since some keys require values, and reject a single-argument call.
type ReservedChatCommandDescriptionKey = Extract<
  TranslationKey,
  "chat.newChat"
>;

const RESERVED_CHAT_COMMANDS = [
  { id: "new", name: "new", command: "/new", descriptionKey: "chat.newChat" },
] as const satisfies readonly {
  id: string;
  name: string;
  command: string;
  descriptionKey: ReservedChatCommandDescriptionKey;
}[];

export type ReservedChatCommand = (typeof RESERVED_CHAT_COMMANDS)[number];
export type ReservedChatCommandId = ReservedChatCommand["id"];

export const getReservedChatCommands = (): ReservedChatCommand[] => [
  ...RESERVED_CHAT_COMMANDS,
];

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
