/** Whose entries the browser holds: a signed-in user, or a visitor. */
export type StorageOwner =
  | { kind: "user"; userId: string }
  | { kind: "visitor" };

/** Ends a visitor's key: `<base>:visitor`. */
export const VISITOR_SUFFIX = ":visitor";
/** Separates a base from its user: `<base>:u:<userId>`. */
export const USER_SEGMENT = ":u:";

/**
 * The key an entry of `base` has for `owner`. Free of imports so code outside
 * the app bundle (the end-to-end fixtures) derives the same key; the account
 * owner module checks that `base` is a registered family.
 */
export const ownerStorageKey = (base: string, owner: StorageOwner): string =>
  owner.kind === "user"
    ? `${base}${USER_SEGMENT}${owner.userId}`
    : `${base}${VISITOR_SUFFIX}`;
