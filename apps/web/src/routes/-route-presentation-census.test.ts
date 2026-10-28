import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

type RouteSource = {
  id: string;
  source: string;
};

type RouteExemption = {
  reason: string;
};

const ROUTE_PRESENTATION_EXEMPTIONS = {
  "/_protected/admin/catalogue": { reason: "Redirects to Knowledge tools." },
  "/_protected/verify/$code": {
    reason: "Completes verification and redirects.",
  },
  "/agent-claim": { reason: "Completes an agent claim and redirects." },
  "/auth/accept-invitation/$invitationId": {
    reason: "The auth shell owns presentation during the invitation callback.",
  },
  "/auth/error": {
    reason: "The auth shell owns presentation for provider errors.",
  },
  "/auth/handoff": { reason: "Authentication handoff callback." },
  "/auth/organization": {
    reason: "The auth shell owns presentation while selecting an organization.",
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
    reason: "The auth shell owns presentation during the two-factor challenge.",
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
  "/law/cases/research/$tableId": {
    reason: "The public law shell owns research presentation.",
  },
  "/law/coverage": {
    reason: "The public law shell owns coverage breadcrumbs.",
  },
  "/mcp/oauth-callback": { reason: "OAuth callback that closes or redirects." },
  "/onboarding": {
    reason: "Standalone onboarding shell; it does not render app breadcrumbs.",
  },
  "/tools/contribute": {
    reason: "The public tools shell owns its breadcrumb.",
  },
} as const satisfies Record<string, RouteExemption>;

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
    '/fixture': {
      id: '/fixture'
      fullPath: '/fixture'
    }
  `;
  const sources = [
    {
      id: "/fixture",
      source: `createFileRoute("/fixture")({ component: FixturePage })`,
    },
  ];

  expect(findMissingRoutePresentation({ routeTree, sources })).toEqual([
    "/fixture: title, breadcrumb",
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
  const paths = routePaths(routeTree);
  const fullPaths = [...paths.values()];
  const missing: string[] = [];

  for (const { id, source } of sources) {
    const fullPath = paths.get(id);
    if (
      fullPath === undefined ||
      !isLeafPath(fullPath, fullPaths) ||
      id in ROUTE_PRESENTATION_EXEMPTIONS
    ) {
      continue;
    }
    const absent = [];
    if (!source.includes("head:") && !source.includes("<title>")) {
      absent.push("title");
    }
    if (!source.includes("presentation: routePresentation(")) {
      absent.push("breadcrumb");
    }
    if (absent.length > 0) {
      missing.push(`${id}: ${absent.join(", ")}`);
    }
  }
  return missing.toSorted();
}

function routePaths(routeTree: string): Map<string, string> {
  const paths = new Map<string, string>();
  const declaration =
    /'([^']+)': \{\s+id: '[^']+'\s+(?:path: '[^']+'\s+)?fullPath: '([^']+)'/gu;
  for (const match of routeTree.matchAll(declaration)) {
    const id = match[1];
    const fullPath = match[2];
    if (id !== undefined && fullPath !== undefined) {
      paths.set(id, fullPath);
    }
  }
  return paths;
}

function isLeafPath(pathname: string, paths: readonly string[]): boolean {
  const prefix = pathname.endsWith("/") ? pathname : `${pathname}/`;
  return !paths.some(
    (candidate) => candidate !== pathname && candidate.startsWith(prefix),
  );
}

async function readRouteSources(directory: string): Promise<RouteSource[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  });
  const sources: RouteSource[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx")) {
      continue;
    }
    const source = await readFile(
      path.join(entry.parentPath, entry.name),
      "utf-8",
    );
    const id = source.match(/createFileRoute\("([^"]+)"\)/u)?.[1];
    if (id !== undefined) {
      sources.push({ id, source });
    }
  }
  return sources;
}
