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

import { compareCodeUnit } from "@stll/collation";
import {
  type CallExpression,
  isObjectLiteralProperty,
  type MemberExpression,
  type Node,
  type ObjectExpression,
  type ObjectPattern,
  parseSource,
  type Program,
  walk,
} from "@stll/scripts/src/syntax-tree";

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
  program: Program;
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
  const parsed: ParsedSource = { program: parseSource(file, source).program };
  byText.set(source, parsed);
  return parsed;
};

const parse = (cache: ParseCache, record: SourceRecord): Program =>
  parsedSource(cache, record).program;

const unwrap = (node: Node): Node => {
  let current = node;
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
};

const literalText = (node: Node | undefined): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? (node.quasis.at(0)?.value.cooked ?? undefined)
    : undefined;
};

const featureName = (name: string | undefined): string | undefined =>
  name?.startsWith(FEATURE_PREFIX) === true ? name : undefined;

/** A non-computed identifier or string key, as TypeScript reads its text. */
const propertyNameText = (
  node:
    | ObjectExpression["properties"][number]
    | ObjectPattern["properties"][number],
): string | undefined => {
  if (node.type === "SpreadElement") {
    return undefined;
  }
  if (node.type === "RestElement") {
    return node.argument.type === "Identifier" ? node.argument.name : undefined;
  }
  if (node.computed) {
    return undefined;
  }
  if (node.key.type === "Identifier") {
    return node.key.name;
  }
  return node.key.type === "Literal" && typeof node.key.value === "string"
    ? node.key.value
    : undefined;
};

/** The name of a non-computed member, spelled as TypeScript's `name.text`. */
const memberName = (node: MemberExpression): string | undefined => {
  if (node.computed) {
    return undefined;
  }
  return node.property.type === "PrivateIdentifier"
    ? `#${node.property.name}`
    : node.property.name;
};

/** `process.env`, `globalThis.process.env`, `Bun.env`, `import.meta.env`. */
const isProcessEnvObject = (node: Node): boolean => {
  const target = unwrap(node);
  if (target.type !== "MemberExpression" || memberName(target) !== "env") {
    return false;
  }
  const owner = unwrap(target.object);
  if (owner.type === "Identifier") {
    return owner.name === "process" || owner.name === "Bun";
  }
  if (owner.type === "MetaProperty") {
    return owner.meta.name === "import";
  }
  if (owner.type !== "MemberExpression") {
    return false;
  }
  const name = memberName(owner);
  return (
    owner.object.type === "Identifier" &&
    owner.object.name === "globalThis" &&
    (name === "process" || name === "Bun")
  );
};

const isApiEnvObject = (node: Node): boolean => {
  const target = unwrap(node);
  return target.type === "Identifier" && target.name === "env";
};

const memberKey = (node: MemberExpression): string | undefined =>
  node.computed ? literalText(node.property) : memberName(node);

const isOwnerCall = (node: CallExpression): boolean => {
  const callee = unwrap(node.callee);
  return callee.type === "Identifier" && callee.name === OWNER_CALL;
};

/** The read form of a member or destructuring on `object`, if it is an env object. */
const envReadForm = (object: Node): FlagReadForm | undefined => {
  if (isProcessEnvObject(object)) {
    return "process-env-read";
  }
  return isApiEnvObject(object) ? "env-read" : undefined;
};

/** Every literal deployment-flag read under `root`, in source order. */
const collectFlagReads = (file: string, root: Node): FlagRead[] => {
  const reads: FlagRead[] = [];
  walk(root, (node, ancestors) => {
    if (node.type === "CallExpression" && isOwnerCall(node)) {
      const flag = featureName(literalText(node.arguments[0]));
      if (flag !== undefined) {
        reads.push({ file, flag, form: "owner-call" });
      }
    } else if (
      isObjectLiteralProperty(node, ancestors.at(-1)) &&
      node.kind === "init" &&
      !node.method &&
      !node.shorthand &&
      FEATURE_TAG_PROPERTIES.has(propertyNameText(node) ?? "")
    ) {
      const flag = featureName(literalText(unwrap(node.value)));
      if (flag !== undefined) {
        reads.push({ file, flag, form: "feature-tag" });
      }
    } else if (node.type === "MemberExpression") {
      const flag = featureName(memberKey(node));
      const form = envReadForm(node.object);
      if (flag !== undefined && form !== undefined) {
        reads.push({ file, flag, form });
      }
    } else if (
      node.type === "VariableDeclarator" &&
      node.init !== null &&
      node.id.type === "ObjectPattern"
    ) {
      const form = envReadForm(node.init);
      if (form !== undefined) {
        for (const element of node.id.properties) {
          const flag = featureName(propertyNameText(element));
          if (flag !== undefined) {
            reads.push({ file, flag, form });
          }
        }
      }
    }
  });
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
  const program = parse(cache, {
    file: DEPLOYMENT_FEATURE_OWNER_FILE,
    source: ownerSource,
  });
  const flags: string[] = [];
  walk(program, (node) => {
    if (
      node.type !== "VariableDeclarator" ||
      node.id.type !== "Identifier" ||
      node.id.name !== OWNER_MAP_NAME ||
      node.init === null
    ) {
      return undefined;
    }
    const literal = unwrap(node.init);
    if (literal.type === "ObjectExpression") {
      for (const property of literal.properties) {
        const flag = featureName(propertyNameText(property));
        if (flag !== undefined) {
          flags.push(flag);
        }
      }
    }
    return "skip-children";
  });
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
  parsed.flagReads ??= collectFlagReads(record.file, parsed.program);
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
