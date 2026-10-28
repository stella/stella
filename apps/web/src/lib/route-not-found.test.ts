import { isNotFound } from "@tanstack/react-router";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import nodePath from "node:path";

import { APIError } from "@/lib/errors/api";
import { loadRouteResource } from "@/lib/route-not-found";
import {
  assertRouteNotFoundCensus,
  type RouteNotFoundCensusEntry,
  type RouteParamExemption,
} from "@/lib/route-not-found-census";

const ID = "0194d94a-1122-7000-8000-123456789abc";

test("malformed route ids become not found without loading", async () => {
  let loaded = false;
  const result = loadRouteResource({
    ids: ["not-an-id"],
    load: async () => {
      loaded = true;
      return {};
    },
  });

  expect(loaded).toBe(false);
  const outcome = await result;
  expect(Result.isError(outcome)).toBe(true);
  if (Result.isError(outcome)) {
    expect(isNotFound(outcome.error)).toBe(true);
  }
});

for (const status of [403, 404]) {
  test(`HTTP ${status} route resources become not found`, async () => {
    const result = loadRouteResource({
      ids: [ID],
      load: async () => {
        throw new APIError({ status, message: "missing" });
      },
    });

    const outcome = await result;
    expect(Result.isError(outcome)).toBe(true);
    if (Result.isError(outcome)) {
      expect(isNotFound(outcome.error)).toBe(true);
    }
  });
}

test("a successful response that names no resource becomes not found", async () => {
  const result = loadRouteResource({
    ids: [ID],
    load: async () => ({ exists: false }),
    exists: ({ exists }) => exists,
  });

  const outcome = await result;
  expect(Result.isError(outcome)).toBe(true);
  if (Result.isError(outcome)) {
    expect(isNotFound(outcome.error)).toBe(true);
  }
});

test("other loader failures are preserved", async () => {
  const failure = new APIError({ status: 500, message: "failed" });
  const result = loadRouteResource({
    ids: [ID],
    load: async () => {
      throw failure;
    },
  });

  const outcome = await result;
  expect(Result.isError(outcome)).toBe(true);
  if (Result.isError(outcome)) {
    expect(outcome.error).toBe(failure);
  }
});

const RESOURCE_PATHS = new Set([
  "/_protected/chat/$threadId",
  "/_protected/chat/workspaces/$workspaceId/$threadId",
  "/_protected/contacts/$contactId",
  "/_protected/workspaces/$workspaceId",
  "/_protected/workspaces/$workspaceId/$viewId",
  "/_protected/workspaces/$workspaceId/correspondence/$correspondenceId",
  "/_protected/workspaces/$workspaceId/invoices/$invoiceId",
  "/_protected/workspaces/$workspaceId/reports/$exportId",
]);

const PARAM_EXEMPTIONS = [
  {
    path: "/_protected/verify/$code",
    reason:
      "The one-time code is not a resource id and has route-specific expiry handling.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/$viewId/",
    reason: "The sibling $viewId layout owns and validates both resource ids.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/$viewId/document",
    reason:
      "The parent workspace and view loaders validate the path resources; entity is a search parameter.",
  },
  {
    path: "/_protected/chat/workspaces/$workspaceId/new",
    reason:
      "The parent workspace loader validates the inherited resource id before this creation leaf runs.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/lists",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/timesheets",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/workflows",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/expenses",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/invoices",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/_protected/workspaces/$workspaceId/invoices/new",
    reason:
      "The parent workspace layout owns and validates the inherited resource id.",
  },
  {
    path: "/auth/accept-invitation/$invitationId",
    reason:
      "Better Auth invitation tokens are opaque, and the loader already maps non-pending tokens to notFound().",
  },
  {
    path: "/knowledge/company-formats/$registry/$companyId",
    reason:
      "Registry and company identifiers are external catalogue keys rather than application resource ids.",
  },
  {
    path: "/knowledge/templates_/catalogue/$packId/$templateId",
    reason:
      "Catalogue pack and template identifiers are static slugs resolved by the catalogue loader.",
  },
  {
    path: "/knowledge/tools_/$entry",
    reason:
      "Tool entries are static slugs with a dedicated not-found presentation on this leaf route.",
  },
  {
    path: "/law/$country/cases/$court/$language/$slug",
    reason:
      "Public-law parameters are canonical external slugs handled by the public decision loader.",
  },
  {
    path: "/law/$country/cases/$court/$slug",
    reason:
      "Public-law parameters are canonical external slugs handled by the public decision loader.",
  },
  {
    path: "/law/$country/statutes/$slug/v/$version",
    reason:
      "Public statute slugs and versions are canonical external identifiers.",
  },
  {
    path: "/law/$country/statutes/",
    reason:
      "The country code is a public-law namespace rather than a resource id.",
  },
  {
    path: "/law/$country/statutes/$slug/",
    reason:
      "The statute slug is a canonical external identifier resolved by the public-law loader.",
  },
  {
    path: "/law/cases/research/$tableId",
    reason:
      "This retired opaque table URL is a redirect-only compatibility leaf.",
  },
  {
    path: "/tools/$slug",
    reason:
      "Public tool slugs resolve from a static registry and have a dedicated leaf not-found component.",
  },
] as const satisfies readonly RouteParamExemption[];

test("every parameterized route and child-bearing layout has a not-found policy", async () => {
  const routesDirectory = nodePath.join(import.meta.dir, "../routes");
  const files = await collectRouteFiles(routesDirectory);
  const routeSources = await Promise.all(
    files.map(async (file) => ({
      file,
      source: await readFile(file, "utf-8"),
    })),
  );
  const routes = routeSources.flatMap(({ file, source }) => {
    const path = /createFileRoute\(\s*["']([^"']+)["']/u.exec(source)?.at(1);
    if (path === undefined) {
      return [];
    }
    return [{ file: file.slice(routesDirectory.length + 1), path, source }];
  });
  const entries = routes.map((route) => ({
    ...route,
    hasChildren: routes.some(
      ({ path }) => path !== route.path && path.startsWith(`${route.path}/`),
    ),
  })) satisfies RouteNotFoundCensusEntry[];
  const routerSource = await readFile(
    nodePath.join(import.meta.dir, "../router.tsx"),
    "utf-8",
  );

  expect(() =>
    assertRouteNotFoundCensus({
      routes: entries,
      resourcePaths: RESOURCE_PATHS,
      exemptions: PARAM_EXEMPTIONS,
      routerSource,
    }),
  ).not.toThrow();
});

test("the census rejects an unguarded resource route and a layout override", () => {
  const unguardedResource = [
    {
      file: "$matterId.tsx",
      path: "/matters/$matterId",
      source: "loader: async () => ({})",
      hasChildren: false,
    },
  ] satisfies RouteNotFoundCensusEntry[];
  const redirectingLayout = [
    {
      file: "matters.tsx",
      path: "/matters",
      source: "notFoundComponent: () => redirect({ to: '/' })",
      hasChildren: true,
    },
  ] satisfies RouteNotFoundCensusEntry[];

  expect(() =>
    assertRouteNotFoundCensus({
      routes: unguardedResource,
      resourcePaths: new Set(["/matters/$matterId"]),
      exemptions: [],
      routerSource: "defaultNotFoundComponent: DefaultNotFoundComponent",
    }),
  ).toThrow(/load resources through/u);
  expect(() =>
    assertRouteNotFoundCensus({
      routes: redirectingLayout,
      resourcePaths: new Set(),
      exemptions: [],
      routerSource: "defaultNotFoundComponent: DefaultNotFoundComponent",
    }),
  ).toThrow(/must inherit/u);
});

async function collectRouteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRouteFiles(entryPath)));
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      files.push(entryPath);
    }
  }
  return files;
}
