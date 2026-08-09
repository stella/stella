export const CHAT_REF_TOKEN_PREFIX = {
  contact: "contact",
  entity: "ent",
  matter: "mat",
  property: "prop",
} as const;

export type ChatRefTokenKind = keyof typeof CHAT_REF_TOKEN_PREFIX;

const createChatRefTokenRegex = (prefix: string): RegExp =>
  new RegExp(`^${prefix}_[1-9]\\d*$`, "u");

const CHAT_REF_TOKEN_REGEX = {
  contact: createChatRefTokenRegex(CHAT_REF_TOKEN_PREFIX.contact),
  entity: createChatRefTokenRegex(CHAT_REF_TOKEN_PREFIX.entity),
  matter: createChatRefTokenRegex(CHAT_REF_TOKEN_PREFIX.matter),
  property: createChatRefTokenRegex(CHAT_REF_TOKEN_PREFIX.property),
} as const satisfies Record<ChatRefTokenKind, RegExp>;

export const isChatRefToken = (
  kind: ChatRefTokenKind,
  value: string,
): boolean => CHAT_REF_TOKEN_REGEX[kind].test(value);
