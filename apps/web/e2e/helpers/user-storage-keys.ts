// Mirrors userStorageKey for a signed-in member. Kept dependency-free so e2e
// helpers can write per-user browser storage without the app's runtime graph;
// user-storage-keys.test.ts pins it to the app's key builder.
export const e2eUserStorageKey = (base: string, userId: string): string =>
  `${base}:u:${userId}`;
