import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

// SSR-reachable modules under /tools. Each is server-rendered for
// anonymous visitors, so none may statically pull an authed query
// module, the auth client, or the install path into module scope.
const SSR_REACHABLE_TOOLS_MODULES = [
  "apps/web/src/routes/tools/route.tsx",
  "apps/web/src/routes/tools/index.tsx",
  "apps/web/src/routes/tools/$slug.tsx",
  "apps/web/src/routes/tools/contribute.tsx",
  "apps/web/src/routes/tools/-components/github-skill-content.ts",
  "apps/web/src/routes/tools/-components/tool-detail.logic.ts",
  "apps/web/src/lib/public-tools-sitemap.ts",
  "apps/web/src/routes/sitemaps/tools[.]xml.ts",
];

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const readSource = async (path: string) =>
  await Bun.file(nodePath.resolve(repoRoot, path)).text();

describe("public tools security invariants", () => {
  test("SSR-reachable tools modules import no authed query, auth, or install modules", async () => {
    const sources = await Promise.all(
      SSR_REACHABLE_TOOLS_MODULES.map(readSource),
    );

    for (const source of sources) {
      expect(source).not.toContain("-queries");
      expect(source).not.toContain("use-install-entry");
      expect(source).not.toContain("catalogue-install");
      expect(source).not.toContain("use-client-auth-status");
      expect(source).not.toContain("@/routes/-auth-context");
      expect(source).not.toMatch(/@\/lib\/auth["']/u);
    }
  });

  test("the install affordance is a client-only lazy import, never static", async () => {
    const source = await readSource("apps/web/src/routes/tools/$slug.tsx");

    // Loaded via dynamic import() so its auth/install deps never enter
    // the SSR-reachable module graph.
    expect(source).toContain(
      'import("@/routes/tools/-components/add-to-stella")',
    );
    expect(source).not.toContain(
      'from "@/routes/tools/-components/add-to-stella"',
    );
  });

  test("the install path lives only in the lazy client component", async () => {
    const addToStella = await readSource(
      "apps/web/src/routes/tools/-components/add-to-stella.tsx",
    );

    expect(addToStella).toContain("installCatalogueEntry");
    expect(addToStella).toContain("useClientAuthStatus");
  });

  test("the download server route gates on the launch flag", async () => {
    const source = await readSource(
      "apps/web/src/routes/tools/$slug_.download.ts",
    );

    expect(source).toContain("isPublicToolsRouteEnabled");
    expect(source).toContain("return notFound()");
    expect(source).not.toContain("-queries");
  });
});
