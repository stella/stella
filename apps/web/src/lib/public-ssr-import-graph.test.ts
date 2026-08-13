import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../..");
const webSrc = nodePath.resolve(repoRoot, "apps/web/src");
const uiSrc = nodePath.resolve(repoRoot, "packages/ui/src");

const PUBLIC_SSR_ROOT_ENTRIES = ["apps/web/src/routes/__root.tsx"] as const;

// These adapters contain reviewed browser reads behind post-mount snapshots,
// external-system effects, or browser-only callbacks. A new entry is a scope
// decision: every other static dependency must remain ambient-state-free.
const REVIEWED_AMBIENT_BOUNDARIES: ReadonlySet<string> = new Set([
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
  "apps/web/src/lib/utils.ts",
  "packages/ui/src/components/date-picker-popover.tsx",
  "packages/ui/src/components/outline-rail.tsx",
  "packages/ui/src/hooks/use-mobile.ts",
]);

const AMBIENT_STATE_PATTERN =
  /\bglobalThis\.(?:window|document|navigator|localStorage|sessionStorage|matchMedia|location|history|screen|devicePixelRatio)\b|(?<![.\w])(?:window|document|navigator|localStorage|sessionStorage|matchMedia|location|history|screen|devicePixelRatio)\b(?!\s*:)|\bDate\.now\s*\(|\bMath\.random\s*\(|\bperformance\.now\s*\(|\bcrypto\.(?:getRandomValues|randomUUID)\s*\(|\b(?:new\s+)?Date\s*\(\s*\)|\b(?:new\s+)?Intl\.[A-Za-z]+\s*\(\s*(?:undefined\s*[,)]|\))/u;
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

const resolveStaticImport = (
  specifier: string,
  fromFile: string,
): string | null => {
  let base: string | null = null;
  let sourceRoot: string | null = null;
  if (specifier.startsWith("@/")) {
    base = nodePath.join(webSrc, specifier.slice(2));
    sourceRoot = webSrc;
  } else if (specifier.startsWith("@stll/ui/")) {
    base = nodePath.join(uiSrc, specifier.slice("@stll/ui/".length));
    sourceRoot = uiSrc;
  } else if (specifier.startsWith(".")) {
    base = nodePath.resolve(nodePath.dirname(fromFile), specifier);
    sourceRoot = fromFile.startsWith(`${uiSrc}${nodePath.sep}`)
      ? uiSrc
      : webSrc;
  }
  if (base === null || sourceRoot === null) {
    return null;
  }

  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (
      candidate.startsWith(`${sourceRoot}${nodePath.sep}`) &&
      /\.tsx?$/u.test(candidate) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
};

const collectStaticImportSpecifiers = (
  source: string,
  file: string,
): readonly string[] => {
  const specifiers: string[] = [];
  const executable = transpileSource(source, file);
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
  return specifiers;
};

const executableSource = (source: string, file: string): string =>
  transpileSource(source, file)
    .replace(/\[\s*["'](?<member>[A-Za-z_$][\w$]*)["']\s*\]/gu, ".$<member>")
    .replace(/"(?:\\.|[^"\\])*"/gu, '""')
    .replace(/'(?:\\.|[^'\\])*'/gu, "''");

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
    for (const specifier of collectStaticImportSpecifiers(source, file)) {
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
});
