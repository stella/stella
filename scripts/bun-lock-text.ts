/**
 * Parses Bun's text lockfile.
 *
 * bun.lock is JSON with trailing commas, not strict JSON, so a plain
 * JSON.parse fails on it as-is. Trailing commas only ever appear directly
 * before a closing `}`/`]`, and that exact sequence cannot occur inside any of
 * bun.lock's own string values (workspace paths, package names, versions,
 * specifiers, or the base64 `sha512-...` integrity hashes), so stripping them
 * is a safe, structure-preserving normalize. Reading the parsed object is
 * immune to Bun's key ordering or nested-object shape, unlike a per-block
 * regex.
 *
 * No third-party imports: CLIs that run before a dependency install use it.
 */
export const parseBunLockText = (lockText: string): unknown =>
  JSON.parse(lockText.replace(/,(\s*[}\]])/gu, "$1"));
