import { randomUUID } from "node:crypto";

import type { TestWorkspace } from "./workspace";

const NONEXISTENT_VERIFICATION_CODE = "abcdmnp239";

export type RouteExpectation =
  | { kind: "rendersInPlace" }
  | { kind: "redirectsTo"; to: string }
  | { kind: "settles" };

// Runtime fixtures every dynamic route path is resolved against. Populated once
// in beforeAll and shared across the per-route test cases.
export type SmokeWorld = {
  workspace: TestWorkspace;
  contactId: string;
  documentRoute: { entityId: string; path: string };
  correspondenceId: string;
};

// A route case declared at collection time. `path` is a function so dynamic
// routes (workspace/contact/document ids) resolve against the beforeAll world
// when the case actually runs, while templates stay static so the per-route
// `test()` cases and the coverage assertion can be built before setup runs.
export type SmokeRouteDef = {
  template: string;
  path: (world: SmokeWorld) => string;
  settleMs?: number;
  expectation?: RouteExpectation;
};

const staticRoute = (
  template: string,
  extra: Omit<SmokeRouteDef, "template" | "path"> = {},
): SmokeRouteDef => ({ template, path: () => template, ...extra });

// Every authenticated route smoked, one case each. Order is the walk order; the
// heavy document route stays last. Kept as declarations (not live SmokeRoutes)
// so each route is its own `test()` with its own timeout instead of one 300s
// mega-test whose budget any single slow or dev-server-stalled route can blow.
export const SMOKE_ROUTE_DEFS: readonly SmokeRouteDef[] = [
  staticRoute("/chat"),
  {
    template: "/chat/$threadId",
    path: () => `/chat/${randomUUID()}`,
  },
  staticRoute("/chat/new", { expectation: { kind: "settles" } }),
  staticRoute("/contacts"),
  staticRoute("/knowledge"),
  staticRoute("/knowledge/clauses"),
  // Reachable in dev/staging (playbooks preview gate is open there); redirects
  // to /knowledge only in production where the flag is off.
  staticRoute("/knowledge/playbooks"),
  staticRoute("/knowledge/styles"),
  staticRoute("/knowledge/templates"),
  staticRoute("/knowledge/tools"),
  staticRoute("/knowledge/workflows"),
  staticRoute("/settings", {
    expectation: { kind: "redirectsTo", to: "/settings/account/profile" },
  }),
  staticRoute("/settings/account/beta", { expectation: { kind: "settles" } }),
  staticRoute("/settings/account/connections"),
  staticRoute("/settings/account/desktop"),
  staticRoute("/settings/account/memory", {
    expectation: { kind: "redirectsTo", to: "/settings/account/profile" },
  }),
  staticRoute("/settings/account/profile"),
  staticRoute("/settings/organization", {
    expectation: { kind: "redirectsTo", to: "/settings/organization/members" },
  }),
  staticRoute("/settings/organization/ai"),
  staticRoute("/settings/organization/anonymization"),
  staticRoute("/settings/organization/audit-logs"),
  staticRoute("/settings/organization/catalogue", {
    expectation: { kind: "redirectsTo", to: "/knowledge/tools" },
  }),
  staticRoute("/settings/organization/document-types"),
  staticRoute("/settings/organization/matter-numbering"),
  staticRoute("/settings/organization/billing", {
    expectation: { kind: "settles" },
  }),
  staticRoute("/settings/organization/members"),
  staticRoute("/settings/organization/usage"),
  staticRoute("/inbox"),
  staticRoute("/workspaces"),
  {
    template: "/chat/workspaces/$workspaceId/$threadId",
    path: (world) => `/chat/workspaces/${world.workspace.id}/${randomUUID()}`,
  },
  {
    template: "/chat/workspaces/$workspaceId/new",
    path: (world) => `/chat/workspaces/${world.workspace.id}/new`,
    expectation: { kind: "settles" },
  },
  {
    template: "/workspaces/$workspaceId",
    path: (world) => `/workspaces/${world.workspace.id}`,
    expectation: { kind: "redirectsTo", to: "" },
  },
  {
    template: "/workspaces/$workspaceId/expenses",
    path: (world) => `/workspaces/${world.workspace.id}/expenses`,
  },
  {
    template: "/workspaces/$workspaceId/invoices",
    path: (world) => `/workspaces/${world.workspace.id}/invoices`,
  },
  {
    // Lists is shown only to callers with list access; the smoke caller has
    // none, so the route leaves before its loader. Granted rendering is covered
    // by the route gate tests.
    template: "/workspaces/$workspaceId/lists",
    path: (world) => `/workspaces/${world.workspace.id}/lists`,
    expectation: { kind: "redirectsTo", to: "/workspaces" },
  },
  {
    template: "/workspaces/$workspaceId/timesheets",
    path: (world) => `/workspaces/${world.workspace.id}/timesheets`,
  },
  {
    template: "/workspaces/$workspaceId/workflows",
    path: (world) => `/workspaces/${world.workspace.id}/workflows`,
  },
  {
    template: "/workspaces/$workspaceId/$viewId",
    path: (world) =>
      `/workspaces/${world.workspace.id}/${world.workspace.viewId}`,
  },
  {
    template: "/contacts/$contactId",
    path: (world) => `/contacts/${world.contactId}`,
  },
  {
    template: "/workspaces/$workspaceId/$viewId/document",
    path: (world) => world.documentRoute.path,
    settleMs: 2000,
  },
  // Routes are partitioned round-robin into serial groups whose shared state
  // (threads, contacts created by earlier routes) shapes the recorded network
  // baseline. Append new routes here so existing routes keep their group.
  staticRoute("/contacts/import"),
  {
    template: "/verify/$code",
    path: () => `/verify/${NONEXISTENT_VERIFICATION_CODE}`,
  },
  {
    template: "/workspaces/$workspaceId/correspondence/$correspondenceId",
    path: (world) =>
      `/workspaces/${world.workspace.id}/correspondence/${world.correspondenceId}`,
  },
  staticRoute("/time"),
  staticRoute("/settings/organization/time-policy"),
  staticRoute("/settings/organization/vat-rates", {
    expectation: { kind: "settles" },
  }),
  staticRoute("/settings/organization/number-series", {
    expectation: { kind: "settles" },
  }),
];

// These routes need richer domain setup than cheap route smoke should own.
// Keeping them explicit means a newly added authenticated route fails the
// coverage assertion until it is either smoked or deliberately placed here.
export const INTENTIONALLY_NOT_SMOKED = new Set([
  // Requires a connected desktop registry account and a real company record.
  "/knowledge/company-formats/$registry/$companyId",
  // A file download handler, not a page.
  "/knowledge/tools/$entry/download",
  "/workspaces/$workspaceId/invoices/$invoiceId",
  "/workspaces/$workspaceId/reports/$exportId",
]);
