import { panic } from "better-result";

/**
 * Model-facing spellings only. Persisted IDs may have the same text; the
 * protocol stage, not a reserved string namespace, distinguishes them.
 */
export const CHAT_REF_TOKEN_PREFIX = {
  contact: "contact",
  entity: "ent",
  matter: "mat",
  property: "prop",
} as const;

export type ChatRefTokenKind = keyof typeof CHAT_REF_TOKEN_PREFIX;

export const CHAT_REF_ENCODING = {
  PERSISTED_RESOURCE_IDS_V1: "persisted-resource-ids-v1",
} as const;

export type ChatRefEncoding =
  (typeof CHAT_REF_ENCODING)[keyof typeof CHAT_REF_ENCODING];

/** Runtime guard for persisted metadata crossing back into chat hydration. */
export const isChatRefEncoding = (value: unknown): value is ChatRefEncoding =>
  typeof value === "string" &&
  Object.values(CHAT_REF_ENCODING).some((encoding) => encoding === value);

export const CHAT_REF_INPUT_STATE = {
  LEGACY_UUID_IDS: "legacy-uuid-ids",
  PERSISTED_RESOURCE_IDS_V1: CHAT_REF_ENCODING.PERSISTED_RESOURCE_IDS_V1,
} as const;

export type ChatRefInputState =
  (typeof CHAT_REF_INPUT_STATE)[keyof typeof CHAT_REF_INPUT_STATE];

const CHAT_REF_INPUT_STATE_BY_ENCODING = {
  [CHAT_REF_ENCODING.PERSISTED_RESOURCE_IDS_V1]:
    CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_IDS_V1,
} as const satisfies Record<ChatRefEncoding, ChatRefInputState>;

/** Classify persisted message metadata before it controls ref hydration. */
export const resolveChatRefInputState = (
  encoding: unknown,
): ChatRefInputState => {
  if (encoding === undefined) {
    return CHAT_REF_INPUT_STATE.LEGACY_UUID_IDS;
  }
  if (!isChatRefEncoding(encoding)) {
    return panic("Unknown persisted chat ref encoding");
  }
  return CHAT_REF_INPUT_STATE_BY_ENCODING[encoding];
};
