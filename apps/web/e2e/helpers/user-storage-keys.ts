// Mirrors userStorageKey for a signed-in member. Kept dependency-free so e2e
// helpers can write per-user browser storage without the app's runtime graph;
// src/lib/account/user-scoped-storage.test.ts pins it to the app's key
// builder (the base keeps its trailing colon, so keys read `:<org>::u:<user>`).
export const e2eUserStorageKey = (base: string, userId: string): string =>
  `${base}:u:${userId}`;
