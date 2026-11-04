import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { isLegacyAdminRouteId } from "@/routes/-organization-settings-route";

type RouteSource = {
  path: string;
  source: string;
};

type RouteNode = {
  id: string;
  routeSymbol: string;
  parentSymbol: string;
};

type RouteExemption = {
  reason: string;
  fields?: readonly ("title" | "breadcrumb")[];
};

const ROUTE_PRESENTATION_EXEMPTIONS: Readonly<Record<string, RouteExemption>> =
  {
    "/": { reason: "The entry route redirects into the appropriate shell." },
    "/_protected/settings/organization/": {
      reason: "Redirects to the General organization settings page.",
    },
    "/_protected/chat/": {
      reason: "The chat layout owns the landing title.",
      fields: ["title"],
    },
    "/_protected/settings/": {
      reason: "The settings layout owns the redirect title.",
      fields: ["title"],
    },
    "/_protected/workspaces/$workspaceId/": {
      reason: "The matter layout owns the default-view redirect title.",
      fields: ["title"],
    },
    "/_protected/workspaces/$workspaceId/$viewId/": {
      reason: "The matter layout owns the selected view title.",
      fields: ["title"],
    },
    "/_protected/settings/organization/catalogue": {
      reason: "Redirects to Knowledge tools.",
    },
    "/_protected/verify/$code": {
      reason: "Completes verification and redirects.",
    },
    "/agent-claim": { reason: "Completes an agent claim and redirects." },
    "/auth/accept-invitation/$invitationId": {
      reason:
        "The auth shell owns presentation during the invitation callback.",
    },
    "/auth/error": {
      reason: "The auth shell owns presentation for provider errors.",
    },
    "/auth/handoff": { reason: "Authentication handoff callback." },
    "/auth/organization": {
      reason:
        "The auth shell owns presentation while selecting an organization.",
    },
    "/auth/otp": {
      reason: "The auth shell owns presentation during the OTP challenge.",
    },
    "/auth/professional-use": {
      reason: "The auth shell owns presentation during account setup.",
    },
    "/auth/reauth": {
      reason: "The auth shell owns presentation during reauthentication.",
    },
    "/auth/two-factor": {
      reason:
        "The auth shell owns presentation during the two-factor challenge.",
    },
    "/consent": {
      reason: "Standalone consent shell; it does not render app breadcrumbs.",
    },
    "/dev": { reason: "Development-only component catalogue." },
    "/law/$country/cases/$court/$slug": {
      reason: "The public law reader owns its document breadcrumb.",
    },
    "/law/$country/statutes/$slug/v/$version": {
      reason: "The public law reader owns its document breadcrumb.",
    },
    "/law/": { reason: "The public law shell owns its breadcrumb." },
    "/law/$country/statutes/": {
      reason: "The public law shell owns its statutes breadcrumb.",
      fields: ["breadcrumb"],
    },
    "/law/$country/statutes/$slug/": {
      reason: "The public law reader owns its document breadcrumb.",
      fields: ["breadcrumb"],
    },
    "/law/cases/": {
      reason: "The public law shell owns its cases breadcrumb.",
      fields: ["breadcrumb"],
    },
    "/law/cases/research/": {
      reason: "Redirects to the public case-law search.",
    },
    "/law/cases/research/$tableId": {
      reason: "The public law shell owns research presentation.",
    },
    "/law/coverage": {
      reason: "The public law shell owns coverage breadcrumbs.",
    },
    "/mcp/oauth-callback": {
      reason: "OAuth callback that closes or redirects.",
    },
    "/onboarding": {
      reason:
        "Standalone onboarding shell; it does not render app breadcrumbs.",
    },
    "/tools/contribute": {
      reason: "The public tools shell owns its breadcrumb.",
    },
    "/tools/": { reason: "The public tools shell owns its breadcrumb." },
    "/tools/$slug": {
      reason: "The public tools shell owns its detail breadcrumb.",
      fields: ["breadcrumb"],
    },
    "/_protected/chat/workspaces/$workspaceId/$threadId": {
      reason: "The live chat name supplies the document title.",
      fields: ["title"],
    },
    "/_protected/chat/workspaces/$workspaceId/new": {
      reason: "Transient redirect into a newly created matter chat.",
    },
    "/_protected/settings/account/connections": {
      reason:
        "The account settings shell owns this nested screen's presentation.",
    },
    "/_protected/workspaces/$workspaceId/$viewId/document": {
      reason: "The document viewer supplies the live document title.",
      fields: ["title"],
    },
    "/_protected/workspaces/$workspaceId/correspondence/$correspondenceId": {
      reason: "The correspondence viewer owns its dynamic presentation.",
    },
    "/_protected/workspaces/$workspaceId/expenses": {
      reason:
        "The matter view shell owns this legacy nested screen's presentation.",
    },
    "/_protected/workspaces/$workspaceId/invoices/$invoiceId": {
      reason: "The invoice editor owns its dynamic presentation.",
    },
    "/_protected/workspaces/$workspaceId/invoices/new": {
      reason: "The invoice editor owns its create-screen presentation.",
    },
    "/_protected/workspaces/$workspaceId/lists": {
      reason:
        "The matter view shell owns this legacy nested screen's presentation.",
    },
    "/_protected/workspaces/$workspaceId/reports/$exportId": {
      reason: "The report viewer owns its dynamic presentation.",
    },
    "/_protected/workspaces/$workspaceId/timesheets": {
      reason:
        "The matter view shell owns this legacy nested screen's presentation.",
    },
    "/_protected/workspaces/$workspaceId/workflows": {
      reason:
        "The matter view shell owns this legacy nested screen's presentation.",
    },
    "/knowledge/company-formats/$registry/$companyId": {
      reason: "The embedded company-format preview does not render app chrome.",
    },
    "/knowledge/": {
      reason: "The Knowledge layout owns the landing title.",
      fields: ["title"],
    },
    "/knowledge/templates": {
      reason: "The templates view supplies its live heading within Knowledge.",
      fields: ["title"],
    },
    "/knowledge/templates_/catalogue/": {
      reason: "The public catalogue owns its breadcrumb.",
      fields: ["breadcrumb"],
    },
    "/law/$country/cases/$court/$language/$slug": {
      reason: "The public law reader owns its document breadcrumb.",
      fields: ["breadcrumb"],
    },
    "/robots.txt": { reason: "Machine-readable endpoint." },
    "/sitemap.xml": { reason: "Machine-readable endpoint." },
    "/sitemaps/law-cases/$country/$year/$month/{$bucket}.xml": {
      reason: "Machine-readable endpoint.",
    },
    "/sitemaps/law-cases/$country/$year/{$month}.xml": {
      reason: "Machine-readable endpoint.",
    },
    "/sitemaps/law-statutes/$country/{$bucket}.xml": {
      reason: "Machine-readable endpoint.",
    },
    "/sitemaps/law-statutes/{$country}.xml": {
      reason: "Machine-readable endpoint.",
    },
    "/sitemaps/law.xml": { reason: "Machine-readable endpoint." },
    "/sitemaps/tools.xml": { reason: "Machine-readable endpoint." },
    "/knowledge/tools_/$entry_/download": {
      reason: "File download endpoint.",
    },
    "/tools/$slug_/download": { reason: "File download endpoint." },
  };

test("every user-facing leaf route declares a title and breadcrumb decision", async () => {
  const routesDirectory = path.resolve(import.meta.dir);
  const routeTree = await readFile(
    path.join(routesDirectory, "../routeTree.gen.ts"),
    "utf-8",
  );
  const sources = await readRouteSources(routesDirectory);

  expect(findMissingRoutePresentation({ routeTree, sources })).toEqual([]);
});

test("the census rejects a fixture leaf without presentation metadata", () => {
  const routeTree = `
    import { Route as FixtureRouteImport } from './routes/fixture'
    import { Route as EscapedRouteImport } from './routes/fixture_.download'
    '/fixture': {
      id: '/fixture'
      fullPath: '/fixture'
      preLoaderRoute: typeof FixtureRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/fixture_/download': {
      id: '/fixture_/download'
      fullPath: '/fixture/download'
      preLoaderRoute: typeof EscapedRouteImport
      parentRoute: typeof rootRouteImport
    }
  `;
  const sources = [
    {
      path: "fixture",
      source: `createFileRoute(\n  "/fixture",\n)({ component: FixturePage })`,
    },
    {
      path: "fixture_.download",
      source: `createFileRoute("/fixture_/download")({
        head: () => ({ meta: [{ title: "Download" }] }),
        staticData: { presentation: routePresentation({ type: "none" }) },
      })`,
    },
  ];

  expect(findMissingRoutePresentation({ routeTree, sources })).toEqual([
    "/fixture: title, breadcrumb",
  ]);
});

test("the census rejects a generated leaf whose source cannot be resolved", () => {
  const routeTree = `
    import { Route as MissingRouteImport } from './routes/missing'
    '/missing': {
      id: '/missing'
      fullPath: '/missing'
      preLoaderRoute: typeof MissingRouteImport
      parentRoute: typeof rootRouteImport
    }
  `;

  expect(findMissingRoutePresentation({ routeTree, sources: [] })).toEqual([
    "/missing: source",
  ]);
});

type CensusInput = {
  routeTree: string;
  sources: readonly RouteSource[];
};

export function findMissingRoutePresentation({
  routeTree,
  sources,
}: CensusInput): string[] {
  const nodes = routeNodes(routeTree);
  const parentSymbols = new Set(nodes.map(({ parentSymbol }) => parentSymbol));
  const sourcePaths = routeSourcePaths(routeTree);
  const sourcesByPath = new Map(sources.map((source) => [source.path, source]));
  const missing: string[] = [];

  for (const { id, routeSymbol } of nodes) {
    if (parentSymbols.has(routeSymbol)) {
      continue;
    }
    const sourcePath = sourcePaths.get(id);
    const source =
      sourcePath === undefined
        ? undefined
        : sourcesByPath.get(sourcePath)?.source;
    if (source === undefined) {
      missing.push(`${id}: source`);
      continue;
    }
    const absent = [];
    const legacyAdminRedirect = isLegacyAdminRouteId(id);
    const exemptFields = ROUTE_PRESENTATION_EXEMPTIONS[id]?.fields;
    const exemptsAll =
      legacyAdminRedirect ||
      (id in ROUTE_PRESENTATION_EXEMPTIONS && exemptFields === undefined);
    if (
      !exemptsAll &&
      !exemptFields?.includes("title") &&
      !source.includes("head:") &&
      !source.includes("<RouteDocumentTitle")
    ) {
      absent.push("title");
    }
    if (
      !exemptsAll &&
      !exemptFields?.includes("breadcrumb") &&
      !source.includes("presentation: routePresentation(")
    ) {
      absent.push("breadcrumb");
    }
    if (absent.length > 0) {
      missing.push(`${id}: ${absent.join(", ")}`);
    }
  }
  return missing.toSorted();
}

function routeSourcePaths(routeTree: string): Map<string, string> {
  const imports = new Map<string, string>();
  const importDeclaration =
    /import \{ Route as (\w+) \} from '\.\/routes\/([^']+)'/gu;
  for (const match of routeTree.matchAll(importDeclaration)) {
    const symbol = match[1];
    const sourcePath = match[2];
    if (symbol !== undefined && sourcePath !== undefined) {
      imports.set(symbol, sourcePath);
    }
  }

  const paths = new Map<string, string>();
  const routeDeclaration =
    /'([^']+)': \{[\s\S]*?preLoaderRoute: typeof (\w+)[\s\S]*?\}/gu;
  for (const match of routeTree.matchAll(routeDeclaration)) {
    const id = match[1];
    const symbol = match[2];
    const sourcePath = symbol === undefined ? undefined : imports.get(symbol);
    if (id !== undefined && sourcePath !== undefined) {
      paths.set(id, sourcePath);
    }
  }
  return paths;
}

function routeNodes(routeTree: string): RouteNode[] {
  const nodes: RouteNode[] = [];
  const declaration = /'([^']+)': \{([\s\S]*?)\n\s*\}/gu;
  for (const match of routeTree.matchAll(declaration)) {
    const id = match[1];
    const body = match[2];
    const preLoaderSymbol = body?.match(/preLoaderRoute: typeof (\w+)/u)?.[1];
    const parentSymbol = body?.match(/parentRoute: typeof (\w+)/u)?.[1];
    const routeSymbol = preLoaderSymbol?.replace(/Import$/u, "");
    if (
      id !== undefined &&
      routeSymbol !== undefined &&
      parentSymbol !== undefined
    ) {
      nodes.push({ id, routeSymbol, parentSymbol });
    }
  }
  return nodes;
}

async function readRouteSources(directory: string): Promise<RouteSource[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  });
  const sources: RouteSource[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts"))
    ) {
      continue;
    }
    const source = await readFile(
      path.join(entry.parentPath, entry.name),
      "utf-8",
    );
    const relativePath = repoRelativePath(
      directory,
      path.join(entry.parentPath, entry.name),
    );
    sources.push({ path: relativePath.replace(/\.(?:ts|tsx)$/u, ""), source });
  }
  return sources;
}
