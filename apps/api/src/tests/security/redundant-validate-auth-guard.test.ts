import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

// Static analysis regression guard for the `validateAuth` duplicate-resolve
// bug: Elysia expands a macro property (here `validateAuth`, directly or
// transitively through `permissions` / `validateWorkspaceAccess`) into an
// independent `resolve` hook every time it appears at a distinct `.guard()`
// / `.group()` / per-route call site, and does not dedupe across those
// sites (only within a single call's hook object). A route file that
// stacks a top-level `.guard({ validateAuth: true })` on top of routes that
// already declare `permissions` (which the `permissions` macro expands to
// `validateAuth: true` — see `permissionMacro` in `lib/auth.ts`) runs the
// full session/member-role/workspace/org-settings resolve twice per
// request for no behavioral benefit.
//
// `validateAuth`'s resolve is memoized per-request (see
// `memoizePerRequest` in `lib/request-memo.ts`), so a reintroduced bare
// guard would no longer cause extra DB queries — but it would still be
// dead, misleading wiring, and a signal that whoever added it did not
// realize `permissions` already covers it. Keeping this guard in place
// documents the invariant for future route files.

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

// These route files stack `permissionMacro` and declare `permissions` on
// every single route (verified by inspection when this test was added).
// A bare top-level `.guard({ validateAuth: true })` is therefore always
// redundant in these specific files.
const ROUTE_FILES_WITH_UNIVERSAL_PERMISSIONS = [
  "apps/api/src/handlers/chat/routes.ts",
  "apps/api/src/handlers/organization-settings/routes.ts",
  "apps/api/src/handlers/workspaces/routes.ts",
];

// Matches a `.guard(...)` call whose hook object carries *only*
// `validateAuth`, however it is formatted (inline or multi-line).
const BARE_VALIDATE_AUTH_GUARD =
  /\.guard\(\s*\{\s*validateAuth:\s*true,?\s*\}\s*\)/u;

describe("no redundant top-level validateAuth guard", () => {
  test.each(ROUTE_FILES_WITH_UNIVERSAL_PERMISSIONS)(
    "%s does not stack a bare `.guard({ validateAuth: true })` on top of per-route `permissions`",
    async (path) => {
      const source = await readSource(path);

      expect(BARE_VALIDATE_AUTH_GUARD.test(source)).toBe(false);
    },
  );
});

// The removed top-level guard was also an accidental safety net: with it
// gone, a route registered in these files WITHOUT `permissions` would run
// with no auth at all. This is the invariant that actually matters, so
// enforce it directly: every route registration must declare
// `permissions` in its options object.
const ROUTE_REGISTRATION = /^\s*\.(?:get|post|put|patch|delete)\(/gmu;

const routeRegistrationBlocks = (source: string): string[] => {
  const starts = [...source.matchAll(ROUTE_REGISTRATION)].map(
    (match) => match.index,
  );
  return starts.map((start, i) => source.slice(start, starts.at(i + 1)));
};

describe("every route declares permissions", () => {
  test.each(ROUTE_FILES_WITH_UNIVERSAL_PERMISSIONS)(
    "%s declares `permissions` on every route registration",
    async (path) => {
      const source = await readSource(path);
      const blocks = routeRegistrationBlocks(source);

      expect(blocks.length).toBeGreaterThan(0);
      const missing = blocks.filter((block) => !block.includes("permissions:"));
      expect(missing).toEqual([]);
    },
  );
});
