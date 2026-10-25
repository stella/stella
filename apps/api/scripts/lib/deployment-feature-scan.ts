// Pure scanner behind `apps/api/scripts/deployment-feature-guard.ts`.
//
// Input is plain `{ file, source }` records (repo-relative paths), the mounted
// route table as plain records, and the committed capability catalog's
// `feature` tags; output is a list of findings. No filesystem access and no
// module imports: the guard script collects the sources and reads the route
// table, and the unit tests feed synthetic or mutated ones.
//
// Three questions, each answered by enumeration rather than by a hand list:
//
//   1. Flags. The declared deployment flags are the keys of the owner's total
//      local-development map (`LOCAL_DEV_ACCESS_BY_FLAG` in
//      `apps/api/src/lib/deployment-feature.ts`). A reader is an owner call
//      with a literal flag, a `feature: "FEATURE_X"` tag on an agent-facing
//      surface, a catalog entry's `feature`, a sanctioned raw `env.FEATURE_X`
//      read, or a mounted route gate. A declared flag with no reader is dead;
//      a read of an undeclared flag is an error.
//   2. Raw reads. A `FEATURE_*` key read off `process.env`, `Bun.env` or
//      `import.meta.env` skips both the env schema and the owner.
//   3. Routes. Every route the API serves is one record of the route table,
//      with the deployment flags its gates stand for. A route's gates run
//      before it by construction, so a gate either covers the route or is not
//      on it. A capability whose catalog entry carries a deployment flag must
//      be mounted behind a gate on that flag, on every mount; a flag read
//      inside the handler is not a gate. Every gate must stand for a declared
//      flag. Every route is either gated, serving a flagged capability, or
//      under a prefix declared always-on; the rest are unclassified.

import { panic } from "better-result";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";

export type SourceRecord = { file: string; source: string };

export const DEPLOYMENT_FEATURE_OWNER_FILE =
  "apps/api/src/lib/deployment-feature.ts";
const OWNER_MAP_NAME = "LOCAL_DEV_ACCESS_BY_FLAG";
const OWNER_CALL = "isDeploymentFeatureEnabled";
const FEATURE_PREFIX = "FEATURE_";
const FEATURE_TAG_PROPERTIES = new Set(["feature", "deploymentFeature"]);

type FlagReadForm =
  /** `isDeploymentFeatureEnabled("FEATURE_X")`. */
  | "owner-call"
  /** `feature: "FEATURE_X"` on a tool, resource or capability declaration. */
  | "feature-tag"
  /** The committed capability catalog's `feature` field. */
  | "catalog-feature"
  /** `env.FEATURE_X` on the API env object (lint-sanctioned files only). */
  | "env-read"
  /** A mounted route's `deploymentFeatureGate("FEATURE_X")`. */
  | "route-gate"
  /** A `FEATURE_*` key read off `process.env`, `Bun.env` or `import.meta.env`. */
  | "process-env-read";

type FlagRead = { file: string; flag: string; form: FlagReadForm };

/** One mounted route, as the guard reads it off the route table. */
export type MountedRoute = {
  method: string;
  /** The path as mounted, prefix included (`/v1/lists/:workspaceId`). */
  path: string;
  /** Deployment flags the route's gates stand for. */
  gateFlags: readonly string[];
  /** Behind the local-development gate: absent outside an open runtime. */
  localDevelopment: boolean;
  /** The catalog capability the route's definition is, if it is one. */
  capability: string | undefined;
};

/** `METHOD /path`: how findings and baseline rows name a route. */
export const routeKey = ({ method, path }: MountedRoute): string =>
  `${method} ${path}`;

export type Finding =
  | { kind: "dead-flag"; flag: string }
  | { kind: "undeclared-read"; flag: string; file: string; form: FlagReadForm }
  | { kind: "process-env-read"; flag: string; file: string }
  | { kind: "undeclared-gate-flag"; flag: string; route: string }
  | {
      kind: "flagged-capability";
      capability: string;
      flag: string;
      route: string;
    }
  | { kind: "unclassified-route"; route: string }
  | { kind: "stale-always-on"; prefix: string };

/** Stable key for a finding: no line numbers, so edits elsewhere never churn it. */
export const findingKey = (finding: Finding): string => {
  switch (finding.kind) {
    case "dead-flag":
      return `dead-flag:${finding.flag}`;
    case "undeclared-read":
      return `undeclared-read:${finding.flag}:${finding.file}`;
    case "process-env-read":
      return `process-env-read:${finding.flag}:${finding.file}`;
    case "undeclared-gate-flag":
      return `undeclared-gate-flag:${finding.flag}@${finding.route}`;
    case "flagged-capability":
      return `flagged-capability:${finding.capability}@${finding.route}`;
    case "unclassified-route":
      return `unclassified-route:${finding.route}`;
    case "stale-always-on":
      return `stale-always-on:${finding.prefix}`;
    default:
      finding satisfies never;
      return panic("deployment-feature-scan: unknown finding kind");
  }
};

/**
 * Findings that may sit in the shrink-only baseline. The rest (an undeclared
 * flag, a raw process-env read, an always-on prefix no route sits under) are
 * always errors: there is no legitimate existing instance to grandfather.
 */
export const BASELINABLE_KINDS: ReadonlySet<Finding["kind"]> = new Set([
  "dead-flag",
  "flagged-capability",
  "unclassified-route",
]);

// --- AST helpers -------------------------------------------------------------

type ParsedSource = {
  sourceFile: ts.SourceFile;
  flagReads?: FlagRead[];
};

/**
 * Parsed sources by file, then by exact text. Scans of edited copies of one
 * tree (the self-test) share a cache, so only the edited files parse again;
 * an edit is a different text and never reuses the original's syntax tree.
 */
export type ParseCache = Map<string, Map<string, ParsedSource>>;

export const createParseCache = (): ParseCache => new Map();

const parsedSource = (
  cache: ParseCache,
  { file, source }: SourceRecord,
): ParsedSource => {
  const byText = cache.get(file) ?? new Map<string, ParsedSource>();
  cache.set(file, byText);
  const cached = byText.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const parsed: ParsedSource = {
    sourceFile: ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  };
  byText.set(source, parsed);
  return parsed;
};

const parse = (cache: ParseCache, record: SourceRecord): ts.SourceFile =>
  parsedSource(cache, record).sourceFile;

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

const featureName = (name: string | undefined): string | undefined =>
  name?.startsWith(FEATURE_PREFIX) === true ? name : undefined;

const propertyNameText = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

/** `process.env`, `globalThis.process.env`, `Bun.env`, `import.meta.env`. */
const isProcessEnvObject = (node: ts.Expression): boolean => {
  const target = unwrap(node);
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "env") {
    return false;
  }
  const owner = unwrap(target.expression);
  if (ts.isIdentifier(owner)) {
    return owner.text === "process" || owner.text === "Bun";
  }
  if (ts.isMetaProperty(owner)) {
    return owner.keywordToken === ts.SyntaxKind.ImportKeyword;
  }
  return (
    ts.isPropertyAccessExpression(owner) &&
    ts.isIdentifier(owner.expression) &&
    owner.expression.text === "globalThis" &&
    (owner.name.text === "process" || owner.name.text === "Bun")
  );
};

const isApiEnvObject = (node: ts.Expression): boolean => {
  const target = unwrap(node);
  return ts.isIdentifier(target) && target.text === "env";
};

const memberKey = (
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined =>
  ts.isPropertyAccessExpression(node)
    ? node.name.text
    : literalText(node.argumentExpression);

const isOwnerCall = (node: ts.CallExpression): boolean => {
  const callee = unwrap(node.expression);
  return ts.isIdentifier(callee) && callee.text === OWNER_CALL;
};

/** The read form of a member or destructuring on `object`, if it is an env object. */
const envReadForm = (object: ts.Expression): FlagReadForm | undefined => {
  if (isProcessEnvObject(object)) {
    return "process-env-read";
  }
  return isApiEnvObject(object) ? "env-read" : undefined;
};

/** Every literal deployment-flag read under `root`, in source order. */
const collectFlagReads = (file: string, root: ts.Node): FlagRead[] => {
  const reads: FlagRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isOwnerCall(node)) {
      const flag = featureName(literalText(node.arguments[0]));
      if (flag !== undefined) {
        reads.push({ file, flag, form: "owner-call" });
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      FEATURE_TAG_PROPERTIES.has(propertyNameText(node.name) ?? "")
    ) {
      const flag = featureName(literalText(unwrap(node.initializer)));
      if (flag !== undefined) {
        reads.push({ file, flag, form: "feature-tag" });
      }
    } else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const flag = featureName(memberKey(node));
      const form = envReadForm(node.expression);
      if (flag !== undefined && form !== undefined) {
        reads.push({ file, flag, form });
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const form = envReadForm(node.initializer);
      if (form !== undefined) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          const flag = featureName(
            ts.isIdentifier(key) || ts.isStringLiteral(key)
              ? key.text
              : undefined,
          );
          if (flag !== undefined) {
            reads.push({ file, flag, form });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return reads;
};

// --- Declared flags ------------------------------------------------------------

/**
 * Keys of the owner's total local-development map. The map `satisfies
 * Record<DeploymentFeatureFlag, ...>`, so typecheck pins it to the env schema's
 * `FEATURE_*` keys exactly; reading it here reads the declared set.
 */
const declaredFlagsFromOwner = (
  cache: ParseCache,
  ownerSource: string,
): string[] => {
  const sourceFile = parse(cache, {
    file: DEPLOYMENT_FEATURE_OWNER_FILE,
    source: ownerSource,
  });
  const flags: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === OWNER_MAP_NAME &&
      node.initializer !== undefined
    ) {
      const literal = unwrap(node.initializer);
      if (ts.isObjectLiteralExpression(literal)) {
        for (const property of literal.properties) {
          const name =
            property.name === undefined
              ? undefined
              : propertyNameText(property.name);
          const flag = featureName(name);
          if (flag !== undefined) {
            flags.push(flag);
          }
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return flags.toSorted();
};

// --- Inputs and results -------------------------------------------------------

export type ScanInput = {
  /** Owner module source (declared flags). */
  ownerSource: string;
  /** Runtime sources whose literal flag reads count as readers. */
  readerFiles: readonly SourceRecord[];
  /** Sources searched for raw process-env flag reads (product + scripts). */
  processEnvFiles: readonly SourceRecord[];
  /** Every route the API serves. */
  routes: readonly MountedRoute[];
  /** Catalog capability id -> its deployment `feature` tag. */
  catalogFeatures: ReadonlyMap<string, string | undefined>;
  /** Path prefixes declared always-on (prefix -> reason). */
  alwaysOnRoutePrefixes: ReadonlyMap<string, string>;
};

export type ScanResult = {
  declared: string[];
  reads: FlagRead[];
  findings: Finding[];
  /** Routes read, gated, and mounted capabilities, for the anti-vacuity check. */
  routeCount: number;
  gatedRouteCount: number;
  capabilityMountCount: number;
};

// --- Flag readers -----------------------------------------------------------------

const fileFlagReads = (cache: ParseCache, record: SourceRecord): FlagRead[] => {
  const parsed = parsedSource(cache, record);
  parsed.flagReads ??= collectFlagReads(record.file, parsed.sourceFile);
  return parsed.flagReads;
};

const scanReaders = ({
  input,
  declared,
  cache,
}: {
  input: ScanInput;
  declared: ReadonlySet<string>;
  cache: ParseCache;
}): { reads: FlagRead[]; findings: Finding[] } => {
  const reads: FlagRead[] = [];
  for (const record of input.readerFiles) {
    if (
      record.file !== DEPLOYMENT_FEATURE_OWNER_FILE &&
      record.source.includes(FEATURE_PREFIX)
    ) {
      reads.push(...fileFlagReads(cache, record));
    }
  }
  for (const [capability, flag] of input.catalogFeatures) {
    if (flag !== undefined) {
      reads.push({
        file: `catalog:${capability}`,
        flag,
        form: "catalog-feature",
      });
    }
  }
  for (const mounted of input.routes) {
    for (const flag of mounted.gateFlags) {
      reads.push({
        file: `route:${routeKey(mounted)}`,
        flag,
        form: "route-gate",
      });
    }
  }
  // A gate on an undeclared flag is reported against its route instead.
  const findings: Finding[] = reads
    .filter(({ flag, form }) => form !== "route-gate" && !declared.has(flag))
    .map(({ flag, file, form }) => ({
      kind: "undeclared-read",
      flag,
      file,
      form,
    }));
  // A process-env read is a defect of its own, never a reader.
  const readFlags = new Set(
    reads
      .filter(({ form }) => form !== "process-env-read")
      .map(({ flag }) => flag),
  );
  for (const flag of declared) {
    if (!readFlags.has(flag)) {
      findings.push({ kind: "dead-flag", flag });
    }
  }
  return { reads, findings };
};

const scanProcessEnvReads = (
  input: ScanInput,
  cache: ParseCache,
): Finding[] => {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const record of [...input.processEnvFiles, ...input.readerFiles]) {
    if (!record.source.includes(FEATURE_PREFIX)) {
      continue;
    }
    for (const read of fileFlagReads(cache, record)) {
      const key = `${read.flag}:${read.file}`;
      if (read.form === "process-env-read" && !seen.has(key)) {
        seen.add(key);
        findings.push({
          kind: "process-env-read",
          flag: read.flag,
          file: read.file,
        });
      }
    }
  }
  return findings;
};

// --- Route table ----------------------------------------------------------------

/** `prefix` covers `path` when it is the path or a whole leading run of its segments. */
const underPrefix = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix.replace(/\/$/u, "")}/`);

type RouteScan = {
  findings: Finding[];
  gatedRouteCount: number;
  capabilityMountCount: number;
};

const scanRoutes = (
  input: ScanInput,
  declared: ReadonlySet<string>,
): RouteScan => {
  const scan: RouteScan = {
    findings: [],
    gatedRouteCount: 0,
    capabilityMountCount: 0,
  };
  const usedPrefixes = new Set<string>();
  for (const mounted of input.routes) {
    const route = routeKey(mounted);
    for (const flag of mounted.gateFlags) {
      if (!declared.has(flag)) {
        scan.findings.push({
          kind: "undeclared-gate-flag",
          flag,
          route,
        });
      }
    }
    const gated = mounted.gateFlags.length > 0 || mounted.localDevelopment;
    if (gated) {
      scan.gatedRouteCount += 1;
    }
    const capabilityFlag =
      mounted.capability === undefined
        ? undefined
        : input.catalogFeatures.get(mounted.capability);
    if (mounted.capability !== undefined) {
      scan.capabilityMountCount += 1;
    }
    // Only a route gate counts: a flag read inside the handler may shape the
    // response without rejecting the request.
    if (
      mounted.capability !== undefined &&
      capabilityFlag !== undefined &&
      !mounted.gateFlags.includes(capabilityFlag)
    ) {
      scan.findings.push({
        kind: "flagged-capability",
        capability: mounted.capability,
        flag: capabilityFlag,
        route,
      });
    }
    const alwaysOn = [...input.alwaysOnRoutePrefixes.keys()].filter((prefix) =>
      underPrefix(mounted.path, prefix),
    );
    for (const prefix of alwaysOn) {
      usedPrefixes.add(prefix);
    }
    if (!gated && capabilityFlag === undefined && alwaysOn.length === 0) {
      scan.findings.push({ kind: "unclassified-route", route });
    }
  }
  for (const prefix of input.alwaysOnRoutePrefixes.keys()) {
    if (!usedPrefixes.has(prefix)) {
      scan.findings.push({ kind: "stale-always-on", prefix });
    }
  }
  return scan;
};

/**
 * `cache` is the caller's: a fresh one per tree, or one shared by scans of
 * edited copies of the same tree.
 */
export const scanDeploymentFeatures = (
  input: ScanInput,
  cache: ParseCache,
): ScanResult => {
  const declared = declaredFlagsFromOwner(cache, input.ownerSource);
  const declaredSet = new Set(declared);
  const readers = scanReaders({ input, declared: declaredSet, cache });
  const routes = scanRoutes(input, declaredSet);
  const findings = [
    ...readers.findings,
    ...scanProcessEnvReads(input, cache),
    ...routes.findings,
  ];
  const unique = new Map(
    findings.map((finding) => [findingKey(finding), finding]),
  );
  return {
    declared,
    reads: readers.reads,
    findings: [...unique.values()].toSorted((a, b) =>
      compareCodeUnit(findingKey(a), findingKey(b)),
    ),
    routeCount: input.routes.length,
    gatedRouteCount: routes.gatedRouteCount,
    capabilityMountCount: routes.capabilityMountCount,
  };
};
