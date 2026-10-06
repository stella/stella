import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { compareCodeUnit } from "@stll/collation";

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

describe("root route registrations", () => {
  test("root plugins match the reviewed census", async () => {
    const source = await readSource("apps/api/src/server.ts");
    const rootStart = source.indexOf("const api = new Elysia()");
    const versionedStart = source.indexOf(
      ".group(STELLA_API_VERSION_PREFIX",
      rootStart,
    );
    expect(rootStart).toBeGreaterThanOrEqual(0);
    expect(versionedStart).toBeGreaterThan(rootStart);

    const rootSource = source.slice(rootStart, versionedStart);
    const plugins = [...rootSource.matchAll(/\.use\(\s*(\w+)\s*\)/gu)].map(
      (match) => {
        const plugin = match.at(1);
        if (plugin === undefined) {
          panic("Expected route plugin capture");
        }
        return plugin;
      },
    );
    expect(plugins.toSorted(compareCodeUnit)).toEqual([
      "agentAuthConfirmRoute",
      "agentAuthRoute",
      "aiAutocompleteRoute",
      "authMetadataRoute",
      "authUiRoute",
      "feedbackPublicRoute",
      "healthRoute",
      "hostedUsageWebhookRoute",
      "internalTimeEntriesRoute",
      "localDevPublicRoutes",
      "mcpRoute",
      "memberTimeTargetsRoute",
      "memoriesRoute",
      "multipartFormParser",
      "myTimeEntriesRoute",
      "notificationsRoute",
      "operatorRoute",
      "smokeRoute",
      "timeApprovalQueueRoute",
      "timeTimersRoute",
      "wellKnownRoute",
    ]);
  });
});
