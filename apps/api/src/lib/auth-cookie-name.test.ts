import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const API_ROOT = path.join(import.meta.dir, "..", "..");
const SEARCH_ROOTS = ["src", "scripts"];

/**
 * Files allowed to reference the prefix: the helper, this test, and the env
 * schema that declares the variable in the first place.
 */
const OWNERS = new Set([
  path.join("src", "lib", "auth-cookie-name.ts"),
  path.join("src", "lib", "auth-cookie-name.test.ts"),
  path.join("src", "env-schema.ts"),
]);

const walk = (directory: string): string[] => {
  const entries = readdirSync(path.join(API_ROOT, directory));
  return entries.flatMap((entry) => {
    const relative = path.join(directory, entry);
    if (statSync(path.join(API_ROOT, relative)).isDirectory()) {
      return walk(relative);
    }
    return relative.endsWith(".ts") ? [relative] : [];
  });
};

/**
 * The cookie name is produced by `auth.ts` and reconstructed by readers that
 * cannot import it. Every hand-rolled copy of the rule is a chance for the two
 * to drift, and a drift surfaces only as an unexplained 401.
 *
 * The guard covers the prefix, not the `.session_token` suffix: the suffix is
 * stable and also appears in permissive cookie-header parsers, which are
 * consumers rather than a second definition. Reading `BETTER_AUTH_COOKIE_PREFIX`
 * outside the helper is what reproduces the branchy part of the rule.
 */
describe("session cookie name has a single owner", () => {
  /**
   * `useSecureCookies` decides whether better-auth prepends `__Secure-`, so a
   * module that computes it independently can produce a name the readers do not
   * expect. Passing the policy's value through is fine — `auth.ts` does exactly
   * that — so this looks for the value being *assigned* an expression rather
   * than for the identifier appearing at all.
   */
  test("no other module computes useSecureCookies", () => {
    const assigned = /useSecureCookies:\s*[^,\n]/u;
    const offenders = SEARCH_ROOTS.flatMap((root) => walk(root)).filter(
      (file) =>
        !OWNERS.has(file) &&
        assigned.test(readFileSync(path.join(API_ROOT, file), "utf-8")),
    );

    expect(offenders).toEqual([]);
  });

  test("no other module derives the prefix itself", () => {
    const offenders = SEARCH_ROOTS.flatMap((root) => walk(root)).filter(
      (file) =>
        !OWNERS.has(file) &&
        readFileSync(path.join(API_ROOT, file), "utf-8").includes(
          "BETTER_AUTH_COOKIE_PREFIX",
        ),
    );

    expect(offenders).toEqual([]);
  });
});
