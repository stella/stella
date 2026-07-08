import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

// These route files stack a top-level `.guard({ validateAuth: true })`
// with per-route `permissions`. The guard is intentional: it is the
// type-level carrier of `validateAuth` for Elysia's context composition
// (`permissions` is a function-form macro that applies `validateAuth` at
// runtime but not in type composition — see "Known Elysia Gotchas" in
// AGENTS.md), and the per-request memoization in `resolveValidateAuth`
// (`lib/auth.ts`) collapses the resulting stacked resolve hooks to one
// resolution per request. See the docstring above `resolveValidateAuth`
// for the full mechanics.
//
// The invariant this file actually enforces is a safety net: every route
// registered in these files must declare `permissions`, otherwise it
// would run with no auth check at all.

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

const ROUTE_FILES_WITH_UNIVERSAL_PERMISSIONS = [
  "apps/api/src/handlers/chat/routes.ts",
  "apps/api/src/handlers/organization-settings/routes.ts",
  "apps/api/src/handlers/workspaces/routes.ts",
];

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
