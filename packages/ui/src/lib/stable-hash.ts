/** A stable, non-negative hash of a key, so one key always picks one swatch. */
export const stableHash = (key: string) => {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash, 31) + (key.codePointAt(i) ?? 0);
  }
  return Math.abs(hash);
};
