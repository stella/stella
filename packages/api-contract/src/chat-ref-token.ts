import * as v from "valibot";

/**
 * How chat spells a tenant item to the model: `<prefix>_<n>` (`ent_3`,
 * `mat_1`), minted per thread by the API's ref registry, never an id. The
 * spellings are declared once, here, so the registry that mints a ref and a
 * step ledger that names an item by it cannot disagree.
 */
export const CHAT_REF_TOKEN_PREFIX = {
  contact: "contact",
  entity: "ent",
  matter: "mat",
  property: "prop",
} as const;

export type ChatRefTokenKind = keyof typeof CHAT_REF_TOKEN_PREFIX;

/** One minted chat ref of `kind`, and nothing else. */
export const chatRefTokenSchema = (kind: ChatRefTokenKind) =>
  v.pipe(
    v.string(),
    v.regex(new RegExp(`^${CHAT_REF_TOKEN_PREFIX[kind]}_[1-9][0-9]*$`, "u")),
  );
