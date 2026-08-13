import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import ts from "typescript";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../..");
const webSrc = nodePath.resolve(repoRoot, "apps/web/src");
const uiSrc = nodePath.resolve(repoRoot, "packages/ui/src");
const workspacePackageRoots = [
  nodePath.resolve(repoRoot, "apps"),
  nodePath.resolve(repoRoot, "packages"),
] as const;

const PUBLIC_SSR_ROOT_ENTRIES = ["apps/web/src/routes/__root.tsx"] as const;

// These lazy modules are gated by ClientOnly, development mode, or a stable
// unauthenticated server snapshot. Every other statically analyzable lazy edge
// participates in the graph by default.
const REVIEWED_NON_SSR_DYNAMIC_IMPORTS: ReadonlySet<string> = new Set([
  "apps/web/src/components/public-workspace-shell.tsx -> @/components/app-sidebar",
  "apps/web/src/components/public-workspace-shell.tsx -> @/components/auth/sign-in-dialog",
  "apps/web/src/components/public-workspace-shell.tsx -> @/components/search-dialog",
  "apps/web/src/components/public-workspace-shell.tsx -> @/components/sidebar-user-menu",
  "apps/web/src/components/public-workspace-shell.tsx -> @/components/workspaces/create-matter-dialog",
  "apps/web/src/routes/__root.tsx -> @/components/dev-root",
  "apps/web/src/routes/law/-case-detail.tsx -> @/components/authenticated-case-law-workspace",
  "apps/web/src/routes/tools/$slug.tsx -> @/routes/tools/-components/add-to-stella",
]);

// These adapters contain reviewed browser reads behind post-mount snapshots,
// external-system effects, or browser-only callbacks. A new entry is a scope
// decision: every other static dependency must remain ambient-state-free.
const REVIEWED_AMBIENT_BOUNDARIES: ReadonlySet<string> = new Set([
  "apps/web/src/components/chat/entity-route-detect.ts",
  "apps/web/src/components/chat/streamdown-mention-link.tsx",
  "apps/web/src/components/inspector/inspector-broadcast.ts",
  "apps/web/src/components/theme-provider.tsx",
  "apps/web/src/components/route-components.tsx",
  "apps/web/src/hooks/use-persisted-sidebar-open.ts",
  "apps/web/src/i18n/i18n-store.ts",
  "apps/web/src/i18n/time-zone.ts",
  "apps/web/src/lib/api-request-context.ts",
  "apps/web/src/lib/analytics/error-reference.ts",
  "apps/web/src/lib/auth.ts",
  "apps/web/src/lib/beta-features.ts",
  "apps/web/src/lib/copy-to-clipboard.ts",
  "apps/web/src/lib/dev-store.ts",
  "apps/web/src/lib/files/email-citations.ts",
  "apps/web/src/lib/utils.ts",
  "packages/ui/src/components/date-picker-popover.tsx",
  "packages/ui/src/components/outline-rail.tsx",
  "packages/ui/src/hooks/use-mobile.ts",
]);

const AMBIENT_STATE_PATTERN =
  /\bglobalThis\.(?:window|document|navigator|localStorage|sessionStorage|matchMedia|location|history|screen|devicePixelRatio|self)\b|\{[^{}]*\b(?:window|document|navigator|localStorage|sessionStorage|matchMedia|location|history|screen|devicePixelRatio|self)\b[^{}]*\}\s*=\s*globalThis\b|(?<![.\w])(?:window|document|navigator|localStorage|sessionStorage|matchMedia|location|history|screen|devicePixelRatio|self)\b(?!\s*:)|\b(?:globalThis\.)?Date\.now\s*\(|\b(?:globalThis\.)?Math\.random\s*\(|\bperformance\.now\s*\(|\bcrypto\.(?:getRandomValues|randomUUID)\s*\(|\b(?:globalThis\.)?Date\s*\(\s*\)|\bnew\s+(?:globalThis\.)?Date(?:\s*\(\s*\)|\s*(?=[;,]))|\bnew\s+(?:globalThis\.)?Intl\.[A-Za-z]+(?:\s*\(\s*\)|\s*(?=[;,]))|\b(?:new\s+)?(?:globalThis\.)?Intl\.[A-Za-z]+\s*\(\s*(?:undefined\s*[,)]|\[\s*\]\s*[,)]|\))/u;
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

const transpileSource = (source: string, file: string): string =>
  file.endsWith(".tsx")
    ? tsxTranspiler.transformSync(source)
    : tsTranspiler.transformSync(source);

const collectRouteEntries = (directory: string): readonly string[] => {
  const entries: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectRouteEntries(candidate));
      continue;
    }
    if (!/\.tsx?$/u.test(entry.name) || entry.name.includes(".test.")) {
      continue;
    }
    const source = readFileSync(candidate, "utf-8");
    if (source.includes("createFileRoute(")) {
      entries.push(candidate);
    }
  }
  return entries;
};

type WorkspaceManifest = {
  name?: string;
  exports?: unknown;
};

const workspaceManifests = new Map<
  string,
  { root: string; manifest: WorkspaceManifest }
>();

const parseWorkspaceManifest = (source: string): WorkspaceManifest => {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const manifest: WorkspaceManifest = {};
  if ("name" in parsed && typeof parsed.name === "string") {
    manifest.name = parsed.name;
  }
  if ("exports" in parsed) {
    manifest.exports = parsed.exports;
  }
  return manifest;
};

const collectWorkspaceManifests = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const root = nodePath.join(directory, entry.name);
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = nodePath.join(root, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = parseWorkspaceManifest(
        readFileSync(manifestPath, "utf-8"),
      );
      if (manifest.name?.startsWith("@stll/")) {
        workspaceManifests.set(manifest.name, { root, manifest });
      }
      continue;
    }
    collectWorkspaceManifests(root);
  }
};

for (const root of workspacePackageRoots) {
  collectWorkspaceManifests(root);
}

const sourceRootForFile = (file: string): string | null => {
  if (file.startsWith(`${webSrc}${nodePath.sep}`)) {
    return webSrc;
  }
  for (const { root } of workspaceManifests.values()) {
    if (file.startsWith(`${root}${nodePath.sep}`)) {
      return root;
    }
  }
  return null;
};

type WorkspaceExport = {
  subpath: string;
  target: string;
};

const conditionalExportTargets = (value: unknown): readonly string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap(conditionalExportTargets);
};

const workspaceExports = (
  exportsField: unknown,
): readonly WorkspaceExport[] => {
  if (typeof exportsField === "string") {
    return [{ subpath: ".", target: exportsField }];
  }
  if (typeof exportsField !== "object" || exportsField === null) {
    return [];
  }
  const entries = Object.entries(exportsField);
  if (!entries.some(([subpath]) => subpath.startsWith("."))) {
    return conditionalExportTargets(exportsField).map((target) => ({
      subpath: ".",
      target,
    }));
  }
  return entries.flatMap(([subpath, value]) =>
    conditionalExportTargets(value).map((target) => ({ subpath, target })),
  );
};

const resolveWorkspaceImport = (specifier: string): readonly string[] => {
  const match = specifier.match(/^(?<name>@stll\/[^/]+)(?<subpath>\/.*)?$/u);
  const name = match?.groups?.name;
  const subpath = match?.groups?.subpath ?? "/";
  const packageInfo =
    name === undefined ? undefined : workspaceManifests.get(name);
  if (packageInfo === undefined) {
    return [];
  }
  const requestedSubpath = subpath === "/" ? "." : `.${subpath}`;
  const declaredExports = workspaceExports(packageInfo.manifest.exports);
  const candidates = declaredExports.flatMap(
    ({ subpath: declared, target }) => {
      if (declared === requestedSubpath) {
        return [target];
      }
      const wildcardOffset = declared.indexOf("*");
      if (wildcardOffset === -1) {
        return [];
      }
      const prefix = declared.slice(0, wildcardOffset);
      const suffix = declared.slice(wildcardOffset + 1);
      if (
        !requestedSubpath.startsWith(prefix) ||
        !requestedSubpath.endsWith(suffix)
      ) {
        return [];
      }
      const wildcard = requestedSubpath.slice(
        prefix.length,
        requestedSubpath.length - suffix.length,
      );
      return [target.replace("*", () => wildcard)];
    },
  );
  if (declaredExports.length > 0 && candidates.length === 0) {
    return [];
  }
  const sourceCandidates =
    candidates.length > 0
      ? candidates
      : [
          `./src${subpath}/index.ts`,
          `./src${subpath}.ts`,
          `./src${subpath}.tsx`,
        ];
  return sourceCandidates.flatMap((target) => {
    const relative = target.replace("*", () => subpath.slice(1));
    const candidate = nodePath.resolve(packageInfo.root, relative);
    return existsSync(candidate) &&
      statSync(candidate).isFile() &&
      /\.tsx?$/u.test(candidate)
      ? [candidate]
      : [];
  });
};

const resolveStaticImport = (
  specifier: string,
  fromFile: string,
): string | null => {
  let base: string | null = null;
  let sourceRoot: string | null = null;
  const workspaceResolved = resolveWorkspaceImport(specifier);
  if (workspaceResolved.length > 0) {
    return workspaceResolved[0] ?? null;
  }
  if (specifier.startsWith("@stll/")) {
    return null;
  }
  if (specifier.startsWith("@/")) {
    base = nodePath.join(webSrc, specifier.slice(2));
    sourceRoot = webSrc;
  } else if (specifier.startsWith(".")) {
    base = nodePath.resolve(nodePath.dirname(fromFile), specifier);
    sourceRoot = sourceRootForFile(fromFile);
  }
  if (base === null || sourceRoot === null) {
    return null;
  }

  const bases = /\.jsx?$/u.test(base) ? [base.replace(/\.jsx?$/u, "")] : [base];
  for (const candidateBase of bases) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = candidateBase + suffix;
      if (
        candidate.startsWith(`${sourceRoot}${nodePath.sep}`) &&
        /\.tsx?$/u.test(candidate) &&
        !candidate.endsWith(".d.ts") &&
        existsSync(candidate) &&
        statSync(candidate).isFile()
      ) {
        return candidate;
      }
    }
  }
  return null;
};

const collectStaticImportSpecifiers = (
  source: string,
  file: string,
  { includeDynamic = false }: { includeDynamic?: boolean } = {},
): readonly string[] => {
  const specifiers: string[] = [];
  let executable = source;
  try {
    executable = transpileSource(source, file);
  } catch {
    // Keep scanning source text when a dependency uses syntax Bun's small
    // transpiler cannot parse; import edges are still statically observable.
  }
  for (const match of executable.matchAll(
    /\bfrom\s*["'](?<specifier>[^"']+)["']/gu,
  )) {
    const specifier = match.groups?.["specifier"];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  for (const match of executable.matchAll(
    /(?:^|[\n;])\s*import\s*["'](?<specifier>[^"']+)["']/gu,
  )) {
    const specifier = match.groups?.["specifier"];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  if (includeDynamic) {
    for (const match of executable.matchAll(
      /\bimport\s*\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu,
    )) {
      const specifier = match.groups?.["specifier"];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return [...new Set(specifiers)];
};

const maskNonExecutableLiterals = (source: string, file: string): string => {
  const masked = source.split("");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const maskRange = (start: number, end: number): void => {
    masked.fill(" ", start, end);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      maskRange(node.getStart(sourceFile), node.end);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      maskRange(node.getStart(sourceFile), node.head.end);
      for (const span of node.templateSpans) {
        visit(span.expression);
        maskRange(span.literal.pos, span.literal.end);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return masked.join("");
};

const normalizeExecutableSource = (source: string, file: string): string => {
  const normalized = source
    .replace(/\?\.\s*\[/gu, "[")
    .replace(/\?\.\s*(?=\()/gu, "")
    .replace(/\?\./gu, ".")
    .replace(/\[\s*["'](?<member>[A-Za-z_$][\w$]*)["']\s*\]/gu, ".$<member>");
  return maskNonExecutableLiterals(normalized, file);
};

const executableSource = (source: string, file: string): string => {
  let executable = source;
  try {
    executable = transpileSource(source, file);
  } catch {
    // Keep scanning source text when a dependency uses syntax Bun's small
    // transpiler cannot parse.
  }
  return normalizeExecutableSource(executable, file);
};

const walkPublicSsrGraph = (
  entries: readonly string[],
): ReadonlySet<string> => {
  const visited = new Set<string>();
  const stack = [...entries];

  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = readFileSync(file, "utf-8");
    const eagerSpecifiers = new Set(
      collectStaticImportSpecifiers(source, file),
    );
    const allSpecifiers = collectStaticImportSpecifiers(source, file, {
      includeDynamic: true,
    });
    for (const specifier of allSpecifiers) {
      const edge = `${nodePath.relative(repoRoot, file)} -> ${specifier}`;
      if (
        !eagerSpecifiers.has(specifier) &&
        REVIEWED_NON_SSR_DYNAMIC_IMPORTS.has(edge)
      ) {
        continue;
      }
      const resolved = resolveStaticImport(specifier, file);
      if (resolved !== null && !visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }
  return visited;
};

describe("public SSR import graph", () => {
  test("ambient-state scan preserves executable expressions around string content", () => {
    const source = [
      'const site = "https://stll.app/window";',
      ["const label = `", "$", "{navigator.language}`;"].join(""),
      "const openedAt = Date();",
      'const randomId = crypto["randomUUID"]();',
    ].join("\n");

    expect(
      AMBIENT_STATE_PATTERN.test(executableSource(source, "fixture.ts")),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          ["const label = `prefix ", "$", "{navigator.language} suffix`;"].join(
            "",
          ),
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          ["const label = `prefix ", "$", "{`window`} suffix`;"].join(""),
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          [
            "const label = `",
            "$",
            '{/}/.test(value) ? navigator.language : ""}`;',
          ].join(""),
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const locale = globalThis?.["navigator"]?.language;',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource("const now = Date?.now();", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource("const today = new Date();", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource("const label = globalThis.Date();", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource("const today = new globalThis.Date();", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const formatter = new Intl.DateTimeFormat();",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const { navigator: browserNavigator } = globalThis;",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const formatter = Intl.DateTimeFormat([]);",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const label = `https://stll.app/window`;",
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const site = "https://stll.app/window";',
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const randomId = crypto["randomUUID"]();',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const saved = globalThis["localStorage"];',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
  });

  test("all static dependencies make ambient render state an explicit boundary", () => {
    const entries = [
      ...PUBLIC_SSR_ROOT_ENTRIES.map((path) =>
        nodePath.resolve(repoRoot, path),
      ),
      ...collectRouteEntries(nodePath.resolve(webSrc, "routes/law")),
      ...collectRouteEntries(nodePath.resolve(webSrc, "routes/tools")),
    ];
    const visited = walkPublicSsrGraph(entries);
    const relativeVisited = [...visited].map((file) =>
      nodePath.relative(repoRoot, file),
    );

    expect(relativeVisited).toContain(
      "apps/web/src/components/public-workspace-shell.tsx",
    );
    expect(relativeVisited).toContain("apps/web/src/routes/law/index.tsx");
    expect(relativeVisited).toContain("apps/web/src/components/sidebar.tsx");
    expect(relativeVisited).toContain("packages/ui/src/hooks/use-mobile.ts");
    expect(relativeVisited).toContain(
      "packages/ui/src/components/date-picker-popover.tsx",
    );
    expect(relativeVisited).toContain("packages/catalogue/src/index.ts");
    expect(relativeVisited).toContain("packages/catalogue/src/loader.ts");
    expect(relativeVisited).toContain("packages/catalogue/src/schema.ts");
    expect(relativeVisited).toContain("packages/text-normalize/src/arabic.ts");
    expect(relativeVisited).toContain(
      "packages/text-normalize/src/diacritics.ts",
    );
    expect(relativeVisited).toContain(
      "apps/web/src/routes/tools/-components/tool-markdown.tsx",
    );
    expect(relativeVisited).toContain(
      "apps/web/src/components/markdown-preview.tsx",
    );
    expect(relativeVisited).toContain(
      "apps/web/src/lib/public-tools-github-content.ts",
    );
    const lazyImportEdges = new Set<string>();
    const importSpecifiers = new Set<string>();
    for (const file of visited) {
      const source = readFileSync(file, "utf-8");
      const eagerSpecifiers = new Set(
        collectStaticImportSpecifiers(source, file),
      );
      for (const specifier of collectStaticImportSpecifiers(source, file, {
        includeDynamic: true,
      })) {
        importSpecifiers.add(specifier);
        if (!eagerSpecifiers.has(specifier)) {
          lazyImportEdges.add(
            `${nodePath.relative(repoRoot, file)} -> ${specifier}`,
          );
        }
      }
    }
    expect(
      [...REVIEWED_NON_SSR_DYNAMIC_IMPORTS]
        .filter((edge) => !lazyImportEdges.has(edge))
        .sort(),
    ).toEqual([]);
    const workspaceImports = new Set(
      [...importSpecifiers].filter((specifier) =>
        specifier.startsWith("@stll/"),
      ),
    );
    for (const specifier of workspaceImports) {
      const packageName = specifier.match(/^(@stll\/[^/]+)/u)?.[1];
      if (!workspaceManifests.has(packageName ?? "")) {
        continue;
      }
      if (specifier.endsWith(".css")) {
        continue;
      }
      expect(packageName).toBeDefined();
      const resolved = resolveStaticImport(
        specifier,
        "apps/web/src/routes/__root.tsx",
      );
      expect(resolved, specifier).not.toBeNull();
    }
    expect(
      [...REVIEWED_AMBIENT_BOUNDARIES]
        .filter((file) => !relativeVisited.includes(file))
        .sort(),
    ).toEqual([]);

    const violations = [...visited]
      .filter((file) =>
        AMBIENT_STATE_PATTERN.test(
          executableSource(readFileSync(file, "utf-8"), file),
        ),
      )
      .map((file) => nodePath.relative(repoRoot, file))
      .filter((file) => !REVIEWED_AMBIENT_BOUNDARIES.has(file))
      .sort();

    expect(violations).toEqual([]);
  });

  test("statically analyzable dynamic imports and workspace exports are covered", () => {
    const source = [
      'const eager = lazy(async () => { const ready = true; return import("@stll/ui/components/date-picker-popover"); });',
      [
        "const ignored = import(`@stll/ui/",
        "$",
        '{"components/date-picker-popover"}`);',
      ].join(""),
    ].join("\n");
    expect(
      collectStaticImportSpecifiers(source, "fixture.ts", {
        includeDynamic: true,
      }),
    ).toEqual(["@stll/ui/components/date-picker-popover"]);
    expect(
      resolveStaticImport(
        "@stll/ui/components/date-picker-popover",
        "fixture.ts",
      ),
    ).toContain(nodePath.join(uiSrc, "components/date-picker-popover.tsx"));
    expect(resolveStaticImport("@stll/catalogue", "fixture.ts")).toContain(
      nodePath.join(repoRoot, "packages/catalogue/src/index.ts"),
    );
    expect(
      resolveStaticImport("@stll/ui/not-exported", "fixture.ts"),
    ).toBeNull();
  });
});
