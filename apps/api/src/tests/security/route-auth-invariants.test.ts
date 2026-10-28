import { describe, expect, test } from "bun:test";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";

import { apiRoutes } from "@/api/api-routes";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { aiAutocompleteRoute } from "@/api/handlers/ai-autocomplete/routes";
import { authMetadataRoute } from "@/api/handlers/auth/routes";
import { authUiRoute } from "@/api/handlers/auth/ui-routes";
import { chatRoute } from "@/api/handlers/chat/routes";
import { desktopFeatureAccessRoute } from "@/api/handlers/desktop-feature-access/routes";
import { desktopPresenceRoute } from "@/api/handlers/desktop-presence/routes";
import { desktopRunnerRoute } from "@/api/handlers/desktop-runner/routes";
import { desktopTimeEntriesRoute } from "@/api/handlers/desktop-time-entries/routes";
import { devPublicRoute } from "@/api/handlers/dev/routes";
import { pdfSigningSessionsRoute } from "@/api/handlers/entities/pdf-signing-sessions-route";
import {
  feedbackPublicRoute,
  feedbackRoute,
} from "@/api/handlers/feedback/routes";
import { healthRoute } from "@/api/handlers/health/routes";
import { hostedUsageWebhookRoute } from "@/api/handlers/hosted-usage-webhook/routes";
import { mcpAppSandboxRoute } from "@/api/handlers/mcp-app-sandbox/routes";
import { mcpRoute } from "@/api/handlers/mcp/routes";
import { memoriesRoute } from "@/api/handlers/memories/routes";
import { notificationsRoute } from "@/api/handlers/notifications/routes";
import { operatorRoute } from "@/api/handlers/operator/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { smokeRoute } from "@/api/handlers/smoke/routes";
import { syntheticRoute } from "@/api/handlers/synthetic/routes";
import { timeApprovalQueueRoute } from "@/api/handlers/time-entries/approval-queue/routes";
import { internalTimeEntriesRoute } from "@/api/handlers/time-entries/internal/routes";
import { myTimeEntriesRoute } from "@/api/handlers/time-entries/me/routes";
import { memberTimeTargetsRoute } from "@/api/handlers/time-entries/members/routes";
import { timeTimersRoute } from "@/api/handlers/time-timers/routes";
import { visualSandboxRoute } from "@/api/handlers/visual-sandbox/routes";
import { wellKnownRoute } from "@/api/handlers/well-known/routes";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import type { RouteConfig, RouteEntry } from "@/api/http/route";
import { AUTH_API_ROUTE } from "@/api/lib/auth/auth-paths";

// Every route these tables mount runs for a signed-in member and checks the
// member's permissions before its handler. The safe handler factories make
// both decisions from the handler config: `access` says who may call, and the
// config's `permissions` gate runs once the member is known. A route mounted
// here without them would run with no permission check at all.

const MEMBER_ACCESS = new Set(["member", "workspace"]);

const TABLES_WITH_UNIVERSAL_PERMISSIONS: readonly (readonly [
  string,
  readonly RouteEntry[],
])[] = [
  ["chat", chatRoute],
  ["organization-settings", organizationSettingsRoute],
  ["workspaces", workspacesRoute],
];

const routeLabel = ({ method, path }: RouteEntry) => `${method} ${path}`;

/** Routes that do not run for a member with a permission gate of their own. */
const ungatedRoutes = (entries: readonly RouteEntry[]): string[] =>
  entries
    .filter(
      ({ definition }) =>
        !MEMBER_ACCESS.has(definition.access) ||
        !Object.hasOwn(definition.config, "permissions"),
    )
    .map(routeLabel);

describe("every route declares permissions", () => {
  test.each(TABLES_WITH_UNIVERSAL_PERMISSIONS)(
    "the %s table gates every route by member permissions",
    (_name, entries) => {
      expect(entries.length).toBeGreaterThan(0);
      expect(ungatedRoutes(entries)).toEqual([]);
    },
  );

  test("the census reports a public route and a member route without permissions", () => {
    const run = async () => "ok";
    const gatedConfig = {
      bodyMode: "none",
      permissions: { workspace: ["read"] },
    } satisfies RouteConfig & { permissions: unknown };
    const entries: RouteEntry[] = [
      {
        method: "GET",
        path: "/public",
        middleware: [],
        definition: { access: "public", config: {}, run },
      },
      {
        method: "GET",
        path: "/ungated",
        middleware: [],
        definition: { access: "member", config: {}, run },
      },
      {
        method: "GET",
        path: "/gated",
        middleware: [],
        definition: { access: "member", config: gatedConfig, run },
      },
    ];
    expect(ungatedRoutes(entries)).toEqual(["GET /public", "GET /ungated"]);
  });
});

/**
 * The tables `apiRoutes` mounts outside the shared `/v1` mount, so outside its
 * shared rate limit: each one either carries its own budget or is reviewed as
 * needing none. Read from the served table: a root route is one whose path is
 * not under the versioned prefix, and it belongs to the reviewed table whose
 * entry carries the same definition (mounting keeps the definition itself).
 */
const ROOT_ROUTE_TABLES: Readonly<Record<string, readonly RouteEntry[]>> = {
  agentAuthConfirmRoute,
  agentAuthRoute,
  aiAutocompleteRoute,
  authMetadataRoute,
  authUiRoute,
  desktopFeatureAccessRoute,
  desktopPresenceRoute,
  desktopRunnerRoute,
  desktopTimeEntriesRoute,
  devPublicRoute,
  feedbackPublicRoute,
  feedbackRoute,
  healthRoute,
  hostedUsageWebhookRoute,
  internalTimeEntriesRoute,
  mcpAppSandboxRoute,
  mcpRoute,
  memberTimeTargetsRoute,
  memoriesRoute,
  myTimeEntriesRoute,
  notificationsRoute,
  operatorRoute,
  pdfSigningSessionsRoute,
  smokeRoute,
  syntheticRoute,
  timeApprovalQueueRoute,
  timeTimersRoute,
  visualSandboxRoute,
  wellKnownRoute,
};

/**
 * The stages the versioned mount puts in front of every route it serves (the
 * shared budget), read off a route the mount is known to serve: what its
 * served entry runs beyond the table's own stages.
 */
const versionedMountStages = (() => {
  const [own] = workspacesRoute;
  const served = apiRoutes.find(
    (entry) => entry.definition === own?.definition,
  );
  if (own === undefined || served === undefined) {
    return [];
  }
  return served.middleware.slice(
    0,
    served.middleware.length - own.middleware.length,
  );
})();

const insideVersionedMount = ({ middleware }: RouteEntry) =>
  versionedMountStages.every((stage, index) => middleware[index] === stage);

/** The reviewed table each definition came from, by identity. */
const tableOfDefinition = new Map(
  Object.entries(ROOT_ROUTE_TABLES).flatMap(([table, entries]) =>
    entries.map(({ definition }) => [definition, table] as const),
  ),
);

const rootRoutes = apiRoutes.filter((entry) => !insideVersionedMount(entry));

describe("root route registrations", () => {
  test("root route tables match the reviewed census", () => {
    // The versioned mount is found, and serves the `/v1` tables behind it.
    expect(versionedMountStages.length).toBeGreaterThan(0);
    expect(
      apiRoutes
        .filter(insideVersionedMount)
        .every(({ path }) => path.startsWith(`${STELLA_API_VERSION_PREFIX}/`)),
    ).toBe(true);
    const servedTables = new Set(
      rootRoutes.flatMap(
        ({ definition }) => tableOfDefinition.get(definition) ?? [],
      ),
    );
    expect([...servedTables].toSorted(compareCodeUnit)).toEqual(
      Object.keys(ROOT_ROUTE_TABLES).toSorted(compareCodeUnit),
    );
    // Every route of a reviewed table is served outside the versioned mount.
    for (const [table, entries] of Object.entries(ROOT_ROUTE_TABLES)) {
      const served = rootRoutes.filter(({ definition }) =>
        entries.some((entry) => entry.definition === definition),
      );
      expect({ table, served: served.length }).toEqual({
        table,
        served: entries.length,
      });
    }
  });

  test("the only root routes outside a reviewed table are the Better Auth mount", () => {
    const unreviewed = rootRoutes.filter(
      ({ definition }) => !tableOfDefinition.has(definition),
    );
    expect(unreviewed.map(routeLabel).toSorted(compareCodeUnit)).toEqual([
      `GET ${AUTH_API_ROUTE}`,
      `POST ${AUTH_API_ROUTE}`,
    ]);
    // One public handler answers both methods; Better Auth reads its own body.
    const [definition, other] = unreviewed.map((route) => route.definition);
    expect(other).toBe(definition);
    expect(definition?.access).toBe("public");
    expect(definition?.config).toMatchObject({ bodyMode: "none" });
  });
});
