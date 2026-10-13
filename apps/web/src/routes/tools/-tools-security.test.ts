import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");
const webSrc = nodePath.resolve(repoRoot, "apps/web/src");

// SSR entry modules under /tools. Each is server-rendered for anonymous
// visitors; the walker below follows their static imports transitively
// and asserts the reachable graph never pulls an authed query module,
// the auth client, or the install path into SSR module scope.
const SSR_ENTRY_MODULES = [
  "apps/web/src/routes/tools/route.tsx",
  "apps/web/src/routes/tools/index.tsx",
  "apps/web/src/routes/tools/$slug.tsx",
  "apps/web/src/routes/tools/contribute.tsx",
  "apps/web/src/routes/tools/$slug_.download.ts",
  "apps/web/src/routes/knowledge/tools_.$entry.tsx",
  "apps/web/src/routes/knowledge/tools_.$entry_.download.ts",
  "apps/web/src/routes/knowledge/tools_.contribute.tsx",
  "apps/web/src/routes/knowledge/-public/public-tools-catalogue.tsx",
  "apps/web/src/lib/public-tools-data.ts",
  "apps/web/src/lib/public-tools-github-content.ts",
  "apps/web/src/lib/public-tools-sitemap.ts",
  "apps/web/src/routes/sitemaps/tools[.]xml.ts",
];

// Import specifiers that must never appear anywhere in the SSR-reachable
// graph. Matched against the raw specifier text (before resolution), so
// the intent survives even for modules outside apps/web/src.
const FORBIDDEN_IMPORT_PATTERNS: readonly RegExp[] = [
  // Authed query modules (e.g. `@/routes/-queries`): prefetched/executed
  // server-side, they would pull session-scoped data into SSR.
  /-queries/u,
  // Install hook + install path: mutate the authed workspace.
  /use-install-entry/u,
  /catalogue-install/u,
  // Client auth context.
  /@\/routes\/-auth-context/u,
  // The browser auth client (not `@/lib/auth-session` or
  // `@/lib/authenticated-user-context`, which are distinct modules).
  /^@\/lib\/auth$/u,
];

// Vetted boundary modules: allowed to appear in the graph, but their
// transitive imports are NOT walked because they only run client-side.
//
// - use-client-auth-status.ts statically imports `@/routes/-queries`
//   (sessionOptions), but that query executes client-side only:
//   sessionOptions dynamically imports the browser auth client and is
//   never prefetched during SSR, so no session data enters the server
//   render. The companion tests assert the install affordance stays
//   lazy-only, keeping the authed path out of the SSR graph.
const VETTED_BOUNDARY_MODULES: ReadonlySet<string> = new Set([
  nodePath.resolve(webSrc, "hooks/use-client-auth-status.ts"),
]);

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

// Resolve a `@/`-aliased or relative import to a concrete file under
// apps/web/src. Returns null for bare packages, unresolvable paths, or
// anything outside the web source tree (those are never walked).
const resolveLocalImport = (
  specifier: string,
  fromFile: string,
): string | null => {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = nodePath.join(webSrc, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = nodePath.resolve(nodePath.dirname(fromFile), specifier);
  }
  if (base === null) {
    return null;
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (
      /\.[cm]?[jt]sx?$/u.test(candidate) &&
      candidate.startsWith(`${webSrc}${nodePath.sep}`) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
};

// Follow the emitted static graph: type imports are erased, and client-only
// dynamic imports remain outside the server module graph.
const importScanners = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

type CollectStaticImportSpecifiersOptions = {
  source: string;
  file: string;
};

const collectStaticImportSpecifiers = ({
  source,
  file,
}: CollectStaticImportSpecifiersOptions): readonly string[] =>
  importScanners[file.endsWith("x") ? "tsx" : "ts"]
    .scanImports(source)
    .filter(({ kind }) => kind === "import-statement")
    .map(({ path }) => path);

type Violation = {
  module: string;
  specifier: string;
};

type WalkResult = {
  visited: ReadonlySet<string>;
  violations: readonly Violation[];
};

const walkSsrGraph = (entries: readonly string[]): WalkResult => {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const stack = [...entries];

  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = readFileSync(file, "utf-8");
    for (const specifier of collectStaticImportSpecifiers({ source, file })) {
      if (
        FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(specifier))
      ) {
        violations.push({
          module: repoRelativePath(repoRoot, file),
          specifier,
        });
        continue;
      }
      const resolved = resolveLocalImport(specifier, file);
      if (resolved === null || VETTED_BOUNDARY_MODULES.has(resolved)) {
        continue;
      }
      if (!visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }

  return { visited, violations };
};

describe("public tools security invariants", () => {
  test("follows static value imports and exports", () => {
    expect(
      collectStaticImportSpecifiers({
        file: "module.tsx",
        source: `
        import type { TypeOnly } from "./types";
        import { type MixedType, value } from "./mixed";
        import { type InlineType } from "./inline-types";
        export type { ExportType } from "./export-types";
        export { forwarded } from "./forwarded";
        export * from "./all";
        import "./side-effect";
        const lazy = import("./lazy");
        // import commented from "./comment";
        const text = 'from "./text"';
      `,
      }),
    ).toEqual(["./mixed", "./forwarded", "./all", "./side-effect"]);
  });

  test("scans TypeScript generic arrows with the source loader", () => {
    expect(
      collectStaticImportSpecifiers({
        file: "module.ts",
        source:
          'import { value } from "./value"; export const identity = <T>(value: T) => value;',
      }),
    ).toEqual(["./value"]);
  });

  test.each(["@/styles/app.css", "@/i18n/langs/en.json"])(
    "treats %s as a non-script asset",
    (specifier) => {
      const file = nodePath.resolve(webSrc, "routes/tools/index.tsx");
      expect(existsSync(nodePath.resolve(webSrc, specifier.slice(2)))).toBe(
        true,
      );
      expect(resolveLocalImport(specifier, file)).toBeNull();
      expect(resolveLocalImport("./route", file)).toBe(
        nodePath.resolve(webSrc, "routes/tools/route.tsx"),
      );
    },
  );

  test("no SSR-reachable tools module statically imports an authed query, the auth client, or the install path", () => {
    const entries = SSR_ENTRY_MODULES.map((path) =>
      nodePath.resolve(repoRoot, path),
    );
    for (const entry of entries) {
      expect(existsSync(entry)).toBe(true);
    }

    const { visited, violations } = walkSsrGraph(entries);

    // Guard against a silent no-op: the walker must actually traverse
    // beyond the entry modules for the assertion to mean anything.
    expect(visited.size).toBeGreaterThan(entries.length);

    // Reported as readable "module -> specifier" strings so a regression
    // names the exact static import chain that reached a forbidden module.
    expect(
      violations.map(({ module, specifier }) => `${module} -> ${specifier}`),
    ).toEqual([]);
  });

  test.each([
    "apps/web/src/routes/tools/$slug.tsx",
    "apps/web/src/routes/knowledge/-public/public-tool-detail.tsx",
  ])(
    "the install affordance in %s is a client-only lazy import, never static",
    (path) => {
      const source = readFileSync(nodePath.resolve(repoRoot, path), "utf-8");

      // Loaded via dynamic import() so its auth/install deps never enter
      // the SSR-reachable module graph.
      expect(source).toContain(
        'import("@/features/knowledge/public/tools/add-to-stella")',
      );
      expect(source).toContain("<ClientOnly");
      expect(source).not.toContain(
        'from "@/features/knowledge/public/tools/add-to-stella"',
      );
    },
  );

  test("unknown tool slugs use the route-specific not-found boundary", () => {
    const source = readFileSync(
      nodePath.resolve(repoRoot, "apps/web/src/routes/tools/$slug.tsx"),
      "utf-8",
    );

    expect(source).toContain("throw notFound()");
    expect(source).toContain("notFoundComponent: PublicToolNotFound");
    expect(source).toContain('from="/tools/$slug"');
  });

  test("the install path lives only in the lazy client component", async () => {
    const addToStella = readFileSync(
      nodePath.resolve(
        repoRoot,
        "apps/web/src/features/knowledge/public/tools/add-to-stella.tsx",
      ),
      "utf-8",
    );

    expect(addToStella).toContain("installCatalogueEntry");
    expect(addToStella).toContain("useClientAuthStatus");
  });

  test("the download server route gates on the launch flag", async () => {
    const source = readFileSync(
      nodePath.resolve(
        repoRoot,
        "apps/web/src/routes/tools/$slug_.download.ts",
      ),
      "utf-8",
    );

    expect(source).toContain("legacyToolsRoutesServed()");
    expect(source).toContain("return publicToolNotFoundResponse()");
    expect(source).not.toContain("-queries");
  });

  test("the Knowledge download serves catalogue slugs only, behind its flag", () => {
    const source = readFileSync(
      nodePath.resolve(
        repoRoot,
        "apps/web/src/routes/knowledge/tools_.$entry_.download.ts",
      ),
      "utf-8",
    );

    expect(source).toContain("isPublicKnowledgeEnabled()");
    expect(source).toContain('classifyToolEntry(params.entry) !== "catalogue"');
    expect(source).toContain("return publicToolNotFoundResponse()");
    expect(source).not.toContain("-queries");
  });
});
