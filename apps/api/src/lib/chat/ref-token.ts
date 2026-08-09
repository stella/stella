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
