import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiDelete, apiGet, apiPut, apiUploadDocx } from "../helpers/api";
import {
  type BrowserErrorCollector,
  createBrowserErrorCollector,
  expect,
  test,
} from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const ROUTE_TREE_PATH = path.resolve(
  import.meta.dirname,
  "../../src/routeTree.gen.ts",
);

type SmokeRoute = {
  template: string;
  path: string;
  settleMs?: number;
};

const STATIC_AUTHENTICATED_ROUTES: readonly SmokeRoute[] = [
  { template: "/chat", path: "/chat" },
  { template: "/chat/$threadId", path: `/chat/${randomUUID()}` },
  { template: "/chat/new", path: "/chat/new" },
  { template: "/contacts", path: "/contacts" },
  { template: "/dev/autocomplete", path: "/dev/autocomplete" },
  { template: "/knowledge", path: "/knowledge" },
  { template: "/knowledge/clauses", path: "/knowledge/clauses" },
  { template: "/knowledge/mcp", path: "/knowledge/mcp" },
  { template: "/knowledge/prompts", path: "/knowledge/prompts" },
  { template: "/knowledge/skills", path: "/knowledge/skills" },
  { template: "/knowledge/templates", path: "/knowledge/templates" },
  { template: "/knowledge/tools", path: "/knowledge/tools" },
  { template: "/settings", path: "/settings" },
  { template: "/settings/account/beta", path: "/settings/account/beta" },
  { template: "/settings/account/desktop", path: "/settings/account/desktop" },
  { template: "/settings/account/profile", path: "/settings/account/profile" },
  { template: "/settings/organization", path: "/settings/organization" },
  { template: "/settings/organization/ai", path: "/settings/organization/ai" },
  {
    template: "/settings/organization/anonymization",
    path: "/settings/organization/anonymization",
  },
  {
    template: "/settings/organization/catalogue",
    path: "/settings/organization/catalogue",
  },
  {
    template: "/settings/organization/matter-numbering",
    path: "/settings/organization/matter-numbering",
  },
  {
    template: "/settings/organization/members",
    path: "/settings/organization/members",
  },
  {
    template: "/settings/organization/usage",
    path: "/settings/organization/usage",
  },
  { template: "/todos", path: "/todos" },
  { template: "/workspaces", path: "/workspaces" },
];

// These routes need richer domain setup than cheap route smoke should own.
// Keeping them explicit means a newly added authenticated route fails this spec
// until it is either smoked or deliberately placed here.
const INTENTIONALLY_NOT_SMOKED = new Set([
  "/knowledge/tools/$skillId",
  "/workspaces/$workspaceId/invoices/$invoiceId",
]);

const AUTHENTICATED_ROUTE_PREFIXES = [
  "/chat",
  "/contacts",
  "/dev/autocomplete",
  "/knowledge",
  "/settings",
  "/todos",
  "/workspaces",
];

test("authenticated routes render without browser errors", async ({
  context,
  request,
}) => {
  test.setTimeout(180_000);

  const cleanupTasks: (() => Promise<void>)[] = [];

  try {
    const workspace = await createTestWorkspace(request, "route-smoke");
    cleanupTasks.push(
      async () => await deleteTestWorkspace(request, workspace.id),
    );

    const contactId = await createContact(request);
    cleanupTasks.push(
      async () => await apiDelete(request, `/contacts/${contactId}`),
    );

    const documentRoute = await createDocumentRoute(request, workspace);

    const routes = [
      ...STATIC_AUTHENTICATED_ROUTES,
      ...createWorkspaceRoutes(workspace),
      {
        template: "/contacts/$contactId",
        path: `/contacts/${contactId}`,
      },
      {
        template: "/workspaces/$workspaceId/entities/$entityId",
        path: `/workspaces/${workspace.id}/entities/${documentRoute.entityId}`,
        settleMs: 1500,
      },
      {
        template: "/workspaces/$workspaceId/$viewId/document",
        path: documentRoute.path,
        settleMs: 2000,
      },
    ];

    await expectAuthenticatedRouteCoverage(routes);

    for (const route of routes) {
      // eslint-disable-next-line no-await-in-loop -- each route gets an isolated page so browser errors can be attributed to its direct render without concurrent route state leaking across pages
      await test.step(route.template, async () => {
        await smokeRoute({ context, route });
      });
    }
  } finally {
    await Promise.all(cleanupTasks.map(async (cleanup) => await cleanup()));
  }
});

const createWorkspaceRoutes = (workspace: TestWorkspace): SmokeRoute[] => [
  {
    template: "/chat/workspaces/$workspaceId/$threadId",
    path: `/chat/workspaces/${workspace.id}/${randomUUID()}`,
  },
  {
    template: "/chat/workspaces/$workspaceId/new",
    path: `/chat/workspaces/${workspace.id}/new`,
  },
  {
    template: "/workspaces/$workspaceId",
    path: `/workspaces/${workspace.id}`,
  },
  {
    template: "/workspaces/$workspaceId/expenses",
    path: `/workspaces/${workspace.id}/expenses`,
  },
  {
    template: "/workspaces/$workspaceId/invoices",
    path: `/workspaces/${workspace.id}/invoices`,
  },
  {
    template: "/workspaces/$workspaceId/timesheets",
    path: `/workspaces/${workspace.id}/timesheets`,
  },
  {
    template: "/workspaces/$workspaceId/$viewId",
    path: `/workspaces/${workspace.id}/${workspace.viewId}`,
  },
];

const createContact = async (request: APIRequestContext): Promise<string> => {
  const contactId = randomUUID();

  await apiPut(request, "/contacts", {
    id: contactId,
    type: "person",
    displayName: `Route Smoke ${contactId.slice(0, 8)}`,
    firstName: "Route",
    lastName: "Smoke",
  });

  return contactId;
};

const createDocumentRoute = async (
  request: APIRequestContext,
  workspace: TestWorkspace,
): Promise<{ entityId: string; path: string }> => {
  const docxBuffer = await readFile(DOCX_PATH);
  const uploaded = await apiUploadDocx(
    request,
    workspace.id,
    workspace.filePropertyId,
    {
      name: "route-smoke.docx",
      mimeType: DOCX_MIME,
      buffer: docxBuffer,
    },
  );

  const entity = await apiGet<{
    fields?: {
      id: string;
      propertyId: string;
      content: { type: string };
    }[];
  }>(request, `/entities/${workspace.id}/entity/${uploaded.entityId}`);

  const fileField = entity.fields?.find(
    (field) =>
      field.propertyId === workspace.filePropertyId &&
      field.content.type === "file",
  );
  if (!fileField) {
    throw new Error("Uploaded entity did not include the expected file field");
  }

  return {
    entityId: uploaded.entityId,
    path:
      `/workspaces/${workspace.id}/${workspace.viewId}/document` +
      `?entity=${uploaded.entityId}&field=${fileField.id}`,
  };
};

const smokeRoute = async ({
  context,
  route,
}: {
  context: BrowserContext;
  route: SmokeRoute;
}) => {
  const page = await context.newPage();
  const browserErrors = createBrowserErrorCollector();
  const detachPage = browserErrors.trackPage(page);

  try {
    await renderSmokeRoute({ browserErrors, page, route });
  } finally {
    detachPage();
    await page.close();
  }
};

const renderSmokeRoute = async ({
  browserErrors,
  page,
  route,
}: {
  browserErrors: Pick<BrowserErrorCollector, "assertEmpty">;
  page: Page;
  route: SmokeRoute;
}) => {
  await page.goto(route.path, { waitUntil: "domcontentloaded" });
  await expect(page, route.template).not.toHaveURL(/\/auth(?:\/|$)/u);
  await assertNoRouteBoundary(page, route.template);
  await expect(page.locator("main").first(), route.template).toBeVisible();

  await page.waitForTimeout(route.settleMs ?? 250);

  await assertNoRouteBoundary(page, route.template);
  browserErrors.assertEmpty(`unexpected browser errors on ${route.template}`);
};

const assertNoRouteBoundary = async (page: Page, routeTemplate: string) => {
  await expect(
    page.getByRole("heading", { name: "Something went wrong" }),
    `route error boundary rendered on ${routeTemplate}`,
  ).toHaveCount(0);
};

const expectAuthenticatedRouteCoverage = async (
  routes: readonly SmokeRoute[],
) => {
  const actual = await readAuthenticatedRouteTemplates();
  const expected = [
    ...routes.map((route) => route.template),
    ...INTENTIONALLY_NOT_SMOKED,
  ].toSorted();

  expect(actual).toEqual(expected);
};

const readAuthenticatedRouteTemplates = async (): Promise<string[]> => {
  const source = await readFile(ROUTE_TREE_PATH, "utf-8");
  const marker = "export interface FileRoutesByTo {";
  const bodyStart = source.indexOf(marker);
  if (bodyStart === -1) {
    throw new Error("Could not find FileRoutesByTo in routeTree.gen.ts");
  }
  const routeBodyStart = bodyStart + marker.length;
  const bodyEnd = source.indexOf("\n}", routeBodyStart);
  if (bodyEnd === -1) {
    throw new Error("Could not find end of FileRoutesByTo in routeTree.gen.ts");
  }
  const body = source.slice(routeBodyStart, bodyEnd);

  return body
    .split("\n")
    .map(parseRouteTreeLine)
    .filter((route): route is string => route !== null)
    .filter(isAuthenticatedRouteTemplate)
    .toSorted();
};

const parseRouteTreeLine = (line: string): string | null => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("'")) {
    return null;
  }

  const routeEnd = trimmed.indexOf("':", 1);
  if (routeEnd === -1) {
    return null;
  }

  return trimmed.slice(1, routeEnd);
};

const isAuthenticatedRouteTemplate = (route: string): boolean =>
  AUTHENTICATED_ROUTE_PREFIXES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`),
  );
