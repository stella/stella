/**
 * Compare semver strings like `0.0.2` or `0.0.2-rc.1`.
 *
 * Returns negative if `a < b`, positive if `a > b`, zero if equal.
 * Treats any prerelease as strictly older than its stable
 * counterpart, so `0.0.1` > `0.0.1-rc.5`. Good enough for the
 * "should we show this banner" decision; not a full semver compare
 * (no build metadata, no numeric prerelease ordering beyond
 * lexicographic).
 */
export const compareSemver = (a: string, b: string): number => {
  const [aCore, aPre] = a.split("-", 2);
  const [bCore, bPre] = b.split("-", 2);
  const aNums = (aCore ?? "0.0.0").split(".").map((n) => Number(n) || 0);
  const bNums = (bCore ?? "0.0.0").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (aNums[i] ?? 0) - (bNums[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (aPre === bPre) {
    return 0;
  }
  if (!aPre) {
    return 1;
  }
  if (!bPre) {
    return -1;
  }
  return aPre < bPre ? -1 : 1;
};
