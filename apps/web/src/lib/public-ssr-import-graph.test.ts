import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

// Exact detector matches reviewed as post-mount snapshots, external-system
// effects, or browser-only callbacks. Counts make new reads fail even inside a
// previously reviewed adapter; removing a read tightens the expected record.
const REVIEWED_AMBIENT_OCCURRENCES = {
  "apps/web/src/components/chat/entity-route-detect.ts": {
    location: 8,
    window: 4,
  },
  "apps/web/src/components/chat/streamdown-mention-link.tsx": { window: 1 },
  "apps/web/src/components/inspector/inspector-broadcast.ts": {
    "Date.now": 1,
    window: 7,
  },
  "apps/web/src/components/route-components.tsx": {
    navigator: 1,
    window: 1,
  },
  "apps/web/src/components/theme-provider.tsx": {
    document: 5,
    localStorage: 8,
    matchMedia: 3,
    window: 6,
  },
  "apps/web/src/hooks/use-persisted-sidebar-open.ts": { localStorage: 2 },
  "apps/web/src/i18n/i18n-store.ts": {
    document: 3,
    navigator: 6,
    window: 2,
  },
  "apps/web/src/i18n/time-zone.ts": {
    "Intl.DateTimeFormat()": 1,
    window: 1,
  },
  "apps/web/src/lib/analytics/error-reference.ts": {
    "globalThis.crypto.getRandomValues": 1,
  },
  "apps/web/src/lib/api-request-context.ts": { window: 1 },
  "apps/web/src/lib/auth.ts": { window: 2 },
  "apps/web/src/lib/beta-features.ts": { window: 1 },
  "apps/web/src/lib/copy-to-clipboard.ts": { navigator: 1 },
  "apps/web/src/lib/dev-store.ts": { window: 3 },
  "apps/web/src/lib/files/email-citations.ts": { window: 6 },
  "apps/web/src/lib/public-tools-github-content.ts": { "Date.now": 1 },
  "apps/web/src/lib/utils.ts": {
    "Math.random": 1,
    document: 2,
  },
  "packages/api-contract/src/matter-reference.ts": {
    ".getFullYear(": 1,
    ".getMonth(": 1,
  },
  "packages/ui/src/components/date-picker-popover.logic.ts": {
    ".getDate(": 2,
    ".getFullYear(": 2,
    ".getMonth(": 2,
  },
  "packages/ui/src/components/date-picker-popover.tsx": {
    "Date.now": 2,
    navigator: 1,
  },
  "packages/ui/src/components/outline-rail.tsx": { "Date.now": 2 },
  "packages/ui/src/hooks/use-mobile.ts": { window: 2 },
} as const satisfies Readonly<Record<string, Readonly<Record<string, number>>>>;

const REVIEWED_AMBIENT_FINGERPRINTS = {
  "apps/web/src/components/chat/entity-route-detect.ts": [
    "02da8827815758b6",
    "02da8827815758b6",
    "02da8827815758b6",
    "1a86257ba16903bb",
    "45742d5a5d6db4d4",
    "867df14c40cad09f",
    "867df14c40cad09f",
    "867df14c40cad09f",
    "c0766743d18d0cd9",
    "cc4dbebc25978b01",
    "cc4dbebc25978b01",
    "de4feabb7a70ae6d",
  ],
  "apps/web/src/components/chat/streamdown-mention-link.tsx": [
    "67ab3bf836370464",
  ],
  "apps/web/src/components/inspector/inspector-broadcast.ts": [
    "1eb6af43609ec10c",
    "26bebede4485e1be",
    "2f261468e42d1413",
    "574fc58f7bffaa23",
    "b5b26d97182c1859",
    "b5b26d97182c1859",
    "c924eeb2f28bc0bf",
    "c924eeb2f28bc0bf",
  ],
  "apps/web/src/components/route-components.tsx": [
    "b9cdf9298e8c6387",
    "ef65f6c5b399769d",
  ],
  "apps/web/src/components/theme-provider.tsx": [
    "0b03be8e934fcda7",
    "19ae3b05964516c2",
    "251d1299f27bb8a8",
    "281d9b0f7e92b3b6",
    "2dd5425082fdde7e",
    "2dd5425082fdde7e",
    "472c9e6f7453336b",
    "472c9e6f7453336b",
    "53b1510f9ddb6595",
    "617f18b530aff9f4",
    "7c18a9531bf27dc2",
    "9ae1d6734a5a0476",
    "9f9500ae6761f0b6",
    "a1f2d1ef57aecace",
    "ac04f6eec64d29da",
    "c48dc8cddb2ff2bd",
    "ca6b9568fc059524",
    "ca6b9568fc059524",
    "d55deea355762618",
    "e5465cb93ead82c1",
    "f81580117d252e19",
    "f81580117d252e19",
  ],
  "apps/web/src/hooks/use-persisted-sidebar-open.ts": [
    "632b8efa89f4e3bb",
    "89daabe4e5be6774",
  ],
  "apps/web/src/i18n/i18n-store.ts": [
    "0f6534bbba47403b",
    "0f6534bbba47403b",
    "0f6534bbba47403b",
    "0f6534bbba47403b",
    "0f6534bbba47403b",
    "0f6534bbba47403b",
    "193234c5fb352236",
    "63c3a7d7513d0ccf",
    "63c3a7d7513d0ccf",
    "8598670941c277a0",
    "f94836c0ddf05ccf",
  ],
  "apps/web/src/i18n/time-zone.ts": ["b2def9e3f1c8f736", "b5b26d97182c1859"],
  "apps/web/src/lib/analytics/error-reference.ts": ["4e7ab7092ac1edbe"],
  "apps/web/src/lib/api-request-context.ts": ["b5b26d97182c1859"],
  "apps/web/src/lib/auth.ts": ["579eebc2dfcb97ff", "66630f8cada16c2b"],
  "apps/web/src/lib/beta-features.ts": ["dc47fff329928ee2"],
  "apps/web/src/lib/copy-to-clipboard.ts": ["571723858de0cabb"],
  "apps/web/src/lib/dev-store.ts": [
    "86bb1e2763b97d68",
    "86bb1e2763b97d68",
    "f8e5c9cecb805dd2",
  ],
  "apps/web/src/lib/files/email-citations.ts": [
    "0177e47cfb39a2f8",
    "271acfb57e6d0261",
    "2a55e8cbbc0fc9fc",
    "4d72934782583eb4",
    "9f4e6ac64ac06ed5",
    "a5af8f2824ffb1a4",
  ],
  "apps/web/src/lib/public-tools-github-content.ts": ["131aa8095e3e22fe"],
  "apps/web/src/lib/utils.ts": [
    "4695abe117e526ff",
    "5b0192bfaef91349",
    "eb4d661e61ec037a",
  ],
  "packages/api-contract/src/matter-reference.ts": [
    "611aac1ac27d2d7d",
    "fb5cb9001a845226",
  ],
  "packages/ui/src/components/date-picker-popover.logic.ts": [
    "078135f7e1507f64",
    "078135f7e1507f64",
    "078135f7e1507f64",
    "453cd9dfd22ede5c",
    "c7dcfb94961f7578",
    "caa3e96ec0936509",
  ],
  "packages/ui/src/components/date-picker-popover.tsx": [
    "021c8cecbf818f77",
    "a1876be9f2976392",
    "bcc30b2032e79cb0",
  ],
  "packages/ui/src/components/outline-rail.tsx": [
    "2eae415d931d64f3",
    "87e08895ed4a0a48",
  ],
  "packages/ui/src/hooks/use-mobile.ts": [
    "2ec5b0d6f441a7e1",
    "a64c4c690e13374e",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const BROWSER_GLOBAL_NAMES =
  "window|document|navigator|localStorage|sessionStorage|matchMedia|location|history|screen|devicePixelRatio|self";
const INTL_CONSTRUCTOR_NAMES =
  "Collator|DateTimeFormat|DisplayNames|ListFormat|NumberFormat|PluralRules|RelativeTimeFormat|Segmenter";
const LOCAL_TIME_DATE_METHOD_NAMES =
  "getDate|getDay|getFullYear|getHours|getMinutes|getMonth|getSeconds|getTimezoneOffset|getYear|setDate|setFullYear|setHours|setMinutes|setMonth|setSeconds|setYear|toDateString|toTimeString";
const AMBIENT_DATE_STRING_SENTINEL = "§";

const ambientStatePatterns = [
  new RegExp(`\\bglobalThis\\.(?:${BROWSER_GLOBAL_NAMES})\\b`, "u"),
  new RegExp(
    `\\{[^{}]*\\b(?:${BROWSER_GLOBAL_NAMES})\\b[^{}]*\\}\\s*=\\s*globalThis\\b`,
    "u",
  ),
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*globalThis\b(?!\s*\.)/u,
  new RegExp(`(?<![.\\w])(?:${BROWSER_GLOBAL_NAMES})\\b(?!\\s*:)`, "u"),
  /\b(?:globalThis\.)?Date\.now\b/u,
  /\b(?:globalThis\.)?Math\.random\b/u,
  /\b(?:globalThis\.)?performance\.now\b/u,
  /\b(?:globalThis\.)?crypto\.(?:getRandomValues|randomUUID)\b/u,
  /\{[^{}]*\bnow\b[^{}]*\}\s*=\s*(?:globalThis\.)?(?:Date|performance)\b/u,
  /\{[^{}]*\brandom\b[^{}]*\}\s*=\s*(?:globalThis\.)?Math\b/u,
  /\{[^{}]*\b(?:getRandomValues|randomUUID)\b[^{}]*\}\s*=\s*(?:globalThis\.)?crypto\b/u,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:globalThis\.)?(?:Date|Math|crypto|performance)\b(?!\s*\.)/u,
  /\b(?:globalThis\.)?Date\s*\(\s*\)/u,
  /\bnew\s+(?:globalThis\.)?Date(?:\s*\(\s*\)|\s*(?=[;,]))/u,
  /\bnew\s+(?:globalThis\.)?Date\s*\(\s*(?:-?\d[\d_]*(?:\.\d+)?|[A-Za-z_$][\w$]*)\s*,/u,
  new RegExp(
    `\\bnew\\s+(?:globalThis\\.)?Date\\s*\\(\\s*${AMBIENT_DATE_STRING_SENTINEL}`,
    "u",
  ),
  /\bnew\s+(?:globalThis\.)?Intl\.[A-Za-z]+(?:\s*\(\s*\)|\s*(?=[;,]))/u,
  /\b(?:new\s+)?(?:globalThis\.)?Intl\.[A-Za-z]+\s*\(\s*(?:undefined\s*[,)]|\[\s*\]\s*[,)]|\))/u,
  /\b(?:new\s+)?(?:globalThis\.)?Intl\.DateTimeFormat\s*\((?:(?!\btimeZone\s*:\s*0\b)[^;])*\)/u,
  /\.(?:toLocaleDateString|toLocaleTimeString)\s*\((?:(?!\btimeZone\s*:\s*0\b)[^;])*\)/u,
  /\bnew\s+(?:globalThis\.)?Date\b[^;]*?\.toLocaleString\s*\((?:(?!\btimeZone\s*:\s*0\b)[^;])*\)/u,
  /\b(?:const|let|var)\s+(?<dateToLocaleStringReceiver>[A-Za-z_$][\w$]*)\s*=\s*new\s+(?:globalThis\.)?Date\b[^;]*;[\s\S]*?\k<dateToLocaleStringReceiver>\.toLocaleString\s*\((?:(?!\btimeZone\s*:\s*0\b)[^;])*\)/u,
  /\.(?:toLocaleDateString|toLocaleString|toLocaleTimeString)\s*\(\s*(?:undefined\s*[,)]|\[\s*\]\s*[,)]|\))/u,
  new RegExp(`\\.(?:${LOCAL_TIME_DATE_METHOD_NAMES})\\s*\\(`, "u"),
  new RegExp(
    `\\{[^{}]*\\b(?:${INTL_CONSTRUCTOR_NAMES})\\b[^{}]*\\}\\s*=\\s*(?:globalThis\\.)?Intl\\b`,
    "u",
  ),
  new RegExp(
    `\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*(?:globalThis\\.)?Intl\\.(?:${INTL_CONSTRUCTOR_NAMES})\\b(?!\\s*\\()`,
    "u",
  ),
] as const;

const AMBIENT_STATE_PATTERN = new RegExp(
  ambientStatePatterns.map(({ source }) => `(?:${source})`).join("|"),
  "u",
);
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

type WorkspacePackageInfo = { root: string; manifest: WorkspaceManifest };

const workspaceManifests = new Map<string, WorkspacePackageInfo>();

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

const replaceExportWildcards = (target: string, wildcard: string): string =>
  target.replaceAll("*", () => wildcard);

const compareCodePoints = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
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

const resolveWorkspaceImport = (
  specifier: string,
  manifests: ReadonlyMap<string, WorkspacePackageInfo> = workspaceManifests,
): readonly string[] => {
  const match = /^(?<name>@stll\/[^/]+)(?<subpath>\/.*)?$/u.exec(specifier);
  const name = match?.groups?.["name"];
  const subpath = match?.groups?.["subpath"] ?? "/";
  const packageInfo = name === undefined ? undefined : manifests.get(name);
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
      return [replaceExportWildcards(target, wildcard)];
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
    const relative = replaceExportWildcards(target, subpath.slice(1));
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
  const maskLiteral = (start: number, end: number): void => {
    maskRange(start, end);
    masked[start] = "0";
  };
  const maskAmbientDateString = (start: number, end: number): void => {
    maskRange(start, end);
    masked[start] = AMBIENT_DATE_STRING_SENTINEL;
  };
  const isDateConstructor = (node: ts.Node | undefined): boolean => {
    if (!node || !ts.isNewExpression(node)) {
      return false;
    }
    return (
      (ts.isIdentifier(node.expression) && node.expression.text === "Date") ||
      (ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "globalThis" &&
        node.expression.name.text === "Date")
    );
  };
  const hasExplicitDateTimeZone = (value: string): boolean =>
    /(?:Z|[+-]\d{2}(?::?\d{2})?)$/iu.test(value);
  const isDeterministicDateString = (value: string): boolean =>
    /^\d{4}-\d{2}-\d{2}$/u.test(value) || hasExplicitDateTimeZone(value);
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (
        isDateConstructor(node.parent) &&
        !isDeterministicDateString(node.text)
      ) {
        maskAmbientDateString(node.getStart(sourceFile), node.end);
        return;
      }
      maskLiteral(node.getStart(sourceFile), node.end);
      return;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      maskLiteral(node.getStart(sourceFile), node.end);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (
        isDateConstructor(node.parent) &&
        !hasExplicitDateTimeZone(node.templateSpans.at(-1)?.literal.text ?? "")
      ) {
        maskAmbientDateString(node.getStart(sourceFile), node.end);
        return;
      }
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

const ambientOccurrenceCounts = (
  source: string,
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  const pattern = new RegExp(AMBIENT_STATE_PATTERN.source, "gu");
  for (const match of source.matchAll(pattern)) {
    const occurrence = match.at(0);
    if (occurrence !== undefined) {
      counts.set(occurrence, (counts.get(occurrence) ?? 0) + 1);
    }
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => compareCodePoints(left, right)),
  );
};

const ambientOccurrenceFingerprints = (source: string): readonly string[] => {
  const fingerprints: string[] = [];
  const pattern = new RegExp(AMBIENT_STATE_PATTERN.source, "gu");
  for (const match of source.matchAll(pattern)) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const lineEnd = source.indexOf("\n", match.index + match[0].length);
    const expression = source
      .slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
      .trim();
    fingerprints.push(
      createHash("sha256").update(expression).digest("hex").slice(0, 16),
    );
  }
  return fingerprints.sort(compareCodePoints);
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
        executableSource("const date = new Date(2026, 7, 13);", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const date = new Date("2026-08-13T12:00:00");',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const date = new Date("2026-08-13T12:00:00Z");',
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource('const date = new Date("2026-08-13");', "fixture.ts"),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const date = new Date(1_786_579_200_000);",
          "fixture.ts",
        ),
      ),
    ).toBe(false);
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
        executableSource("const now = Date.now;", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource("const Clock = Date;", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource("const browser = globalThis;", "fixture.ts"),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const { now: capturedNow } = performance;",
          "fixture.ts",
        ),
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
          "const label = fixedDate.toLocaleDateString();",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const label = fixedDate.toLocaleTimeString(undefined);",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const label = amount.toLocaleString([]);",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const label = fixedDate.toLocaleDateString("en");',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const fixedDate = new Date("2026-08-13T00:00:00Z"); const label = fixedDate.toLocaleString("en");',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const label = (42).toLocaleString("en");',
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const amount = 42; const label = amount.toLocaleString("en");',
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const label = fixedDate.toLocaleDateString("en", { timeZone: "UTC" });',
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const formatter = Intl.DateTimeFormat("en");',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const formatter = Intl.DateTimeFormat("en", { timeZone: "UTC" });',
          "fixture.ts",
        ),
      ),
    ).toBe(false);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const formatter = Intl.DateTimeFormat("en", { timeZone: undefined });',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          'const fixedDate = new Date("2026-08-13T00:00:00Z"); const year = fixedDate.getFullYear();',
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const { DateTimeFormat: Formatter } = Intl; const formatter = new Formatter();",
          "fixture.ts",
        ),
      ),
    ).toBe(true);
    expect(
      AMBIENT_STATE_PATTERN.test(
        executableSource(
          "const Formatter = Intl.DateTimeFormat; const formatter = new Formatter();",
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
      const packageName = /^(@stll\/[^/]+)/u.exec(specifier)?.[1];
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
    const actualOccurrences = Object.fromEntries(
      [...visited]
        .map(
          (file) =>
            [
              nodePath.relative(repoRoot, file),
              ambientOccurrenceCounts(
                executableSource(readFileSync(file, "utf-8"), file),
              ),
            ] as const,
        )
        .filter(([, occurrences]) => Object.keys(occurrences).length > 0)
        .sort(([left], [right]) => compareCodePoints(left, right)),
    );

    expect(actualOccurrences).toEqual(REVIEWED_AMBIENT_OCCURRENCES);

    const actualFingerprints = Object.fromEntries(
      [...visited]
        .map(
          (file) =>
            [
              nodePath.relative(repoRoot, file),
              ambientOccurrenceFingerprints(
                executableSource(readFileSync(file, "utf-8"), file),
              ),
            ] as const,
        )
        .filter(([, fingerprints]) => fingerprints.length > 0)
        .sort(([left], [right]) => compareCodePoints(left, right)),
    );
    expect(actualFingerprints).toEqual(REVIEWED_AMBIENT_FINGERPRINTS);
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
    const fixtureManifests = new Map([
      [
        "@stll/resolver-fixture",
        {
          root: nodePath.resolve(repoRoot, "packages/ui"),
          manifest: {
            exports: {
              "./codeql/*": "./src/*/../components/*.tsx",
            },
          },
        },
      ],
    ]);
    expect(
      resolveWorkspaceImport(
        "@stll/resolver-fixture/codeql/button",
        fixtureManifests,
      ),
    ).toEqual([
      nodePath.resolve(repoRoot, "packages/ui/src/components/button.tsx"),
    ]);
    expect(replaceExportWildcards("./*/generated/*", "$&")).toBe(
      "./$&/generated/$&",
    );
  });
});
