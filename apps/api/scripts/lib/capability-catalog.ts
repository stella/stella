// Pure helpers for the capability-catalog exporter
// (`apps/api/scripts/export-capability-catalog.ts`).
//
// Everything here is a pure function over plain data: no I/O, no handler-graph
// import, no module side effects. The exporter owns the override/mapping tables
// (a catalog membership is a reviewed decision that lives next to the script)
// and feeds them in; these helpers only apply them. Keeping the derivation
// logic side-effect-free is what lets `capability-catalog.test.ts` exercise id
// derivation, verb classification, and override handling without spinning up
// the 300+ handler modules.

import { panic } from "better-result";

import type { HandlerKind } from "./enumerate-safe-handlers";

/** Handler-tree prefix stripped to turn a file path into a capability id. */
export const HANDLERS_ROOT_PREFIX = "apps/api/src/handlers/";

/**
 * Capability id from a repo-relative handler path plus (optional) export name:
 * directories and basename joined with `.`, the export name suffixed when the
 * endpoint is a named export rather than the file's default. e.g.
 * `apps/api/src/handlers/time-entries/create.ts` (default) -> `time-entries.create`;
 * a named export `foo` in the same file -> `time-entries.create.foo`.
 */
export const deriveCapabilityId = ({
  file,
  exportName,
}: {
  file: string;
  exportName: string | undefined;
}): string => {
  if (!file.startsWith(HANDLERS_ROOT_PREFIX)) {
    return panic(
      `capability-catalog: handler path is outside ${HANDLERS_ROOT_PREFIX}: ${file}`,
    );
  }
  const withoutPrefix = file.slice(HANDLERS_ROOT_PREFIX.length);
  const withoutExt = withoutPrefix.replace(/\.ts$/u, "");
  const base = withoutExt.split("/").join(".");
  return exportName === undefined ? base : `${base}.${exportName}`;
};

/** The domain of a capability id: its first `.`-separated segment. */
export const deriveDomain = (id: string): string => {
  const domain = id.split(".").at(0);
  if (domain === undefined || domain.length === 0) {
    return panic(`capability-catalog: cannot derive a domain from id "${id}"`);
  }
  return domain;
};

export type AccessClassification = {
  access: "read" | "write";
  destructive: boolean;
};

// Permission action verbs, split into the read and write buckets. Verbs outside
// both sets are "unclassifiable" and force an explicit ACCESS_OVERRIDES entry
// so a newly introduced verb fails the export instead of silently defaulting.
const READ_VERBS = new Set(["read", "list", "view"]);
const WRITE_VERBS = new Set(["create", "update", "delete", "manage", "write"]);
const DESTRUCTIVE_VERBS = new Set(["delete"]);

export type VerbClassification =
  | { ok: true; value: AccessClassification }
  | { ok: false; unknownVerbs: string[] };

/**
 * Classify a handler's permission verbs into read/write + destructive. Fails
 * (ok: false) if any verb is outside both buckets, listing the offending verbs
 * so the caller can require an override.
 */
export const classifyVerbs = (verbs: readonly string[]): VerbClassification => {
  const unknown = [
    ...new Set(
      verbs.filter((verb) => !READ_VERBS.has(verb) && !WRITE_VERBS.has(verb)),
    ),
  ].sort();
  if (unknown.length > 0) {
    return { ok: false, unknownVerbs: unknown };
  }
  const access = verbs.some((verb) => WRITE_VERBS.has(verb)) ? "write" : "read";
  const destructive = verbs.some((verb) => DESTRUCTIVE_VERBS.has(verb));
  return { ok: true, value: { access, destructive } };
};

/** Final `.`-separated id segment; the basename for a default export. */
export const finalIdSegment = (id: string): string =>
  id.split(".").at(-1) ?? id;

const GET_LIKE_PREFIX = /^(?:get|list|read)/u;

const DESTRUCTIVE_TOKENS = new Set(["delete", "remove"]);

/**
 * Whether the capability's final id segment names a delete-like operation.
 * Complements the permission-verb path: several deletes are authorized via an
 * `update` verb on a parent resource (e.g. `document-types.delete-by-id` under
 * `organizationSettings:["update"]`), which the verb classification alone
 * would report as non-destructive.
 *
 * The segment is tokenized on hyphens and camelCase boundaries; the name is
 * delete-like when the FIRST or LAST token is `delete`/`remove`. This catches
 * both verb-first (`delete-by-id`, `deleteWorkspaceAnonymizationTerm`) and
 * verb-last (`workspace-members-remove`, `entity-links-delete`) naming.
 * Mid-name tokens deliberately do not match, to avoid false positives.
 */
export const isDestructiveName = (id: string): boolean => {
  const tokens = finalIdSegment(id)
    .split(/-|(?=[A-Z])/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
  const first = tokens.at(0);
  const last = tokens.at(-1);
  return (
    (first !== undefined && DESTRUCTIVE_TOKENS.has(first)) ||
    (last !== undefined && DESTRUCTIVE_TOKENS.has(last))
  );
};

export type AccessResolution =
  | { status: "resolved"; access: "read" | "write"; destructive: boolean }
  | { status: "needs-override"; reason: string };

/**
 * Resolve a capability's access classification:
 *  - handlers with permissions derive from their verbs; an unclassifiable verb
 *    requires an ACCESS_OVERRIDES entry (id -> classification), else fails;
 *  - handlers without permissions (session/token/public) default to read only
 *    when the final id segment looks like a getter (get/list/read prefix),
 *    otherwise require an override;
 *  - a resolved entry whose final id segment starts with delete/remove is
 *    escalated to destructive (deletes authorized via an `update` verb would
 *    otherwise come out non-destructive) unless the id is in
 *    `destructiveNameOptOuts` (reviewed false positives, e.g. an unlink that
 *    destroys nothing).
 */
export const resolveAccess = ({
  id,
  verbs,
  hasPermissions,
  overrides,
  destructiveNameOptOuts = new Set<string>(),
}: {
  id: string;
  verbs: readonly string[];
  hasPermissions: boolean;
  overrides: Record<string, AccessClassification>;
  destructiveNameOptOuts?: ReadonlySet<string>;
}): AccessResolution => {
  const escalate = (resolution: AccessResolution): AccessResolution => {
    if (
      resolution.status !== "resolved" ||
      resolution.destructive ||
      !isDestructiveName(id) ||
      destructiveNameOptOuts.has(id)
    ) {
      return resolution;
    }
    return { ...resolution, destructive: true };
  };

  const override = overrides[id];
  if (hasPermissions) {
    const classified = classifyVerbs(verbs);
    if (classified.ok) {
      return escalate({ status: "resolved", ...classified.value });
    }
    if (override) {
      return escalate({ status: "resolved", ...override });
    }
    return {
      status: "needs-override",
      reason: `unclassifiable permission verb(s): ${classified.unknownVerbs.join(", ")}`,
    };
  }
  if (override) {
    return escalate({ status: "resolved", ...override });
  }
  if (GET_LIKE_PREFIX.test(finalIdSegment(id))) {
    return { status: "resolved", access: "read", destructive: false };
  }
  return {
    status: "needs-override",
    reason:
      "permissionless handler whose name does not start with get/list/read",
  };
};

/**
 * Override entries that are not actually needed (the id classifies without help,
 * or names a capability that no longer exists) are fail-open clutter: report
 * them so the table only ever documents real, still-required overrides.
 */
export const findStaleAccessOverrides = ({
  overrides,
  usedIds,
}: {
  overrides: Record<string, AccessClassification>;
  usedIds: readonly string[];
}): string[] => {
  const used = new Set(usedIds);
  return Object.keys(overrides)
    .filter((id) => !used.has(id))
    .sort();
};

export type HandlerKindResolution =
  | { status: "resolved"; kind: HandlerKind }
  | { status: "needs-override"; reason: string };

/**
 * Resolve a capability's handler-scope kind from the factory kinds its file
 * calls. A file that calls exactly one factory attributes every one of its
 * endpoints to that kind. A file mixing factories cannot attribute an export
 * unambiguously, so each such id requires a HANDLER_KIND_OVERRIDES entry.
 */
export const resolveHandlerKind = ({
  id,
  kinds,
  overrides,
}: {
  id: string;
  kinds: readonly HandlerKind[];
  overrides: Record<string, HandlerKind>;
}): HandlerKindResolution => {
  const override = overrides[id];
  if (override) {
    return { status: "resolved", kind: override };
  }
  const [first, ...rest] = kinds;
  if (first === undefined) {
    return {
      status: "needs-override",
      reason: "no safe-handler factory detected in the file",
    };
  }
  if (rest.length === 0) {
    return { status: "resolved", kind: first };
  }
  return {
    status: "needs-override",
    reason: `file mixes handler kinds (${kinds.join(", ")}); attribution is ambiguous`,
  };
};

/**
 * Per-entry input-schema byte cap for the committed catalog snapshot, mirroring
 * the CLI trust boundary's MAX_TOOL_SCHEMA_BYTES. A handful of view/table
 * schemas serialize to 150KB+ each (deep recursive condition/filter unions),
 * which would make the committed artifact unreviewable. The server always has
 * the live schema from the handler config; the snapshot omits oversize schemas
 * and marks the entry `inputSchemaTruncated` instead.
 */
export const MAX_CAPABILITY_SCHEMA_BYTES = 64 * 1024;

export type CapabilityInputSchema = {
  body?: unknown;
  params?: unknown;
  query?: unknown;
};

export type SchemaCapResult =
  | { truncated: false; inputSchema: CapabilityInputSchema }
  | { truncated: true };

/**
 * Apply the snapshot byte cap to one entry's input schema. Size is measured on
 * the compact JSON serialization (the committed format), in UTF-8 bytes; an
 * oversize schema returns `truncated: true` so the exporter omits `inputSchema`
 * and sets `inputSchemaTruncated` on the entry.
 */
export const capInputSchema = (
  inputSchema: CapabilityInputSchema,
  maxBytes: number = MAX_CAPABILITY_SCHEMA_BYTES,
): SchemaCapResult => {
  const bytes = Buffer.byteLength(JSON.stringify(inputSchema), "utf-8");
  if (bytes > maxBytes) {
    return { truncated: true };
  }
  return { truncated: false, inputSchema };
};

/**
 * The committed catalog format: compact JSON (no indentation — pretty-printing
 * the full catalog produced a 6.6MB artifact) plus a trailing newline.
 * Determinism comes from the caller passing id-sorted entries.
 */
export const serializeCatalog = (entries: readonly unknown[]): string =>
  `${JSON.stringify(entries)}\n`;

/**
 * Textual count of `capability` dispositions in a handler file's source. Same
 * approach as the coverage guard's factory call-site counting: an inline
 * endpoint's config is invisible to module enumeration, but its disposition is
 * still text in the file.
 */
export const countCapabilityDispositions = (source: string): number =>
  source.match(/type:\s*"capability"/gu)?.length ?? 0;

export type InlineCapabilityFile = {
  /** Repo-relative file path. */
  id: string;
  source: string;
  /** Enumerable `{ config, handler }` endpoints in the file with a `capability` disposition. */
  enumerableCapabilityCount: number;
};

export type InlineCapabilityMismatch = {
  id: string;
  inlineCount: number;
  allowed: number;
};

/**
 * Inline-capability invariant: per file, the textual `capability` disposition
 * count minus the enumerable capability endpoints must exactly equal the pinned
 * allowlist count (0 when not allowlisted). An inline (non-enumerable) endpoint
 * cannot be projected into the capability catalog, so an unpinned inline
 * `capability` disposition is a capability that would silently vanish from the
 * catalog — the export must fail instead. Pinned counts are exact so they can
 * only shrink (refactor to an endpoint module), never silently grow.
 */
export const findInlineCapabilityMismatches = ({
  files,
  allowlist,
}: {
  files: readonly InlineCapabilityFile[];
  allowlist: Record<string, number>;
}): InlineCapabilityMismatch[] => {
  const mismatches: InlineCapabilityMismatch[] = [];
  for (const { id, source, enumerableCapabilityCount } of files) {
    const inlineCount =
      countCapabilityDispositions(source) - enumerableCapabilityCount;
    const allowed = allowlist[id] ?? 0;
    if (inlineCount !== allowed) {
      mismatches.push({ id, inlineCount, allowed });
    }
  }
  return mismatches.sort((a, b) => a.id.localeCompare(b.id));
};

/** Module-alias import specifier for a handler file: `apps/api/src/handlers/time-entries/create.ts` -> `@/api/handlers/time-entries/create`. */
export const deriveHandlerImportPath = (file: string): string => {
  const SRC_PREFIX = "apps/api/src/";
  if (!file.startsWith(SRC_PREFIX)) {
    return panic(
      `capability-catalog: handler path is outside ${SRC_PREFIX}: ${file}`,
    );
  }
  return `@/api/${file.slice(SRC_PREFIX.length).replace(/\.ts$/u, "")}`;
};

/** One dispatch record: capability id, the module it lives in, and (for a named export) which export. */
export type CapabilityDispatchRecord = {
  id: string;
  importPath: string;
  exportName: string | undefined;
};

/**
 * Strict shape guards for every value interpolated into the generated dispatch
 * module. All three values are derived mechanically (id from the handler file
 * path + export name, import path from the same file path), so a mismatch means
 * the derivation produced something outside its own contract: the serializer
 * throws rather than emitting it. Combined with `JSON.stringify` for the actual
 * literal emission, no interpolated value can alter the generated module's code
 * structure.
 *
 * - id: dot-joined path segments plus an optional camelCase export-name
 *   segment (e.g. `entities.read-summaries.readEntitySummariesCount`).
 * - import path: the fixed `@/api/` alias prefix plus lowercase path segments.
 * - export name: a plain TS identifier.
 */
const DISPATCH_ID_PATTERN = /^[a-zA-Z0-9.-]+$/u;
const DISPATCH_IMPORT_PATH_PATTERN = /^@\/api\/[a-z0-9/.-]+$/u;
const DISPATCH_EXPORT_NAME_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u;

const assertSafeDispatchRecord = ({
  id,
  importPath,
  exportName,
}: CapabilityDispatchRecord): void => {
  if (!DISPATCH_ID_PATTERN.test(id)) {
    panic(
      `capability-catalog: refusing to emit dispatch entry with unsafe id ${JSON.stringify(id)} (must match ${DISPATCH_ID_PATTERN})`,
    );
  }
  if (!DISPATCH_IMPORT_PATH_PATTERN.test(importPath)) {
    panic(
      `capability-catalog: refusing to emit dispatch entry "${id}" with unsafe import path ${JSON.stringify(importPath)} (must match ${DISPATCH_IMPORT_PATH_PATTERN})`,
    );
  }
  if (
    exportName !== undefined &&
    !DISPATCH_EXPORT_NAME_PATTERN.test(exportName)
  ) {
    panic(
      `capability-catalog: refusing to emit dispatch entry "${id}" with unsafe export name ${JSON.stringify(exportName)} (must match ${DISPATCH_EXPORT_NAME_PATTERN})`,
    );
  }
};

/**
 * Serialize the generated capability-dispatch module: a typed map from
 * capability id to a lazy `import()` thunk (plus the export name for a non-
 * default export). Same determinism contract as the JSON catalog: the caller
 * passes id-sorted records. The server reads `.load()` then the named (or
 * default) export to reach the `{ config, handler }` endpoint definition, so the
 * generic invoke path runs the exact code REST does.
 *
 * Every interpolated value is validated against a strict pattern first (see
 * `assertSafeDispatchRecord`) and emitted through `JSON.stringify`, so the
 * generated code's structure cannot be influenced by a crafted handler path or
 * export name. The output is raw (single-line entries); the exporter formats it
 * with oxfmt before writing/comparing, mirroring how the CLI codegen formats
 * its generated modules, so the committed artifact passes `oxfmt --check`.
 */
export const serializeDispatchModule = (
  records: readonly CapabilityDispatchRecord[],
): string => {
  const header = `// GENERATED by apps/api/scripts/export-capability-catalog.ts — do not edit.
//
// Maps every capability id (see capability-catalog.json) to a lazy import of
// its handler module. \`invoke_capability\` loads the module on demand and calls
// the module's \`{ config, handler }\` export, so the generic path reuses the
// safe-handler wrapper (permission + usage gates) unchanged. Keys here are byte-
// for-byte the catalog's ids; a drift guard (\`--check\`) and a registry test
// both enforce that.

export type CapabilityDispatchEntry = {
  /** Lazy module import; the endpoint definition is its default (or named) export. */
  load: () => Promise<Record<string, unknown>>;
  /** Present only for a named (non-default) export. */
  exportName?: string;
};

export const CAPABILITY_DISPATCH = {
`;
  const body = records
    .map((record) => {
      assertSafeDispatchRecord(record);
      const { id, importPath, exportName } = record;
      const loader = `load: async () => await import(${JSON.stringify(importPath)})`;
      const named =
        exportName === undefined
          ? ""
          : `, exportName: ${JSON.stringify(exportName)}`;
      return `  ${JSON.stringify(id)}: { ${loader}${named} },`;
    })
    .join("\n");
  const footer = `
} as const satisfies Record<string, CapabilityDispatchEntry>;

export type CapabilityId = keyof typeof CAPABILITY_DISPATCH;
`;
  return `${header}${body}\n${footer}`;
};

/**
 * Elysia-context features a synthesized `invoke_capability` context cannot
 * honor: a handler that reaches for these needs the real HTTP request/response
 * plumbing the generic path does not reconstruct. Each pattern targets the
 * destructured-context usage handlers actually write (e.g. `set.status`,
 * `redirect(...)`), not just the `ctx.`-qualified form.
 */
export const CONTEXT_FIDELITY_PATTERNS: readonly {
  feature: string;
  pattern: RegExp;
}[] = [
  { feature: "ctx.set", pattern: /\bctx\.set\b/u },
  { feature: "set.status", pattern: /\bset\.status\b/u },
  { feature: "set.headers", pattern: /\bset\.headers\b/u },
  { feature: "set.cookie", pattern: /\bset\.cookie\b/u },
  { feature: "set.redirect", pattern: /\bset\.redirect\b/u },
  { feature: "ctx.headers[", pattern: /\bctx\.headers\s*\[/u },
  { feature: "ctx.cookie", pattern: /\bctx\.cookie\b/u },
  { feature: "ctx.redirect", pattern: /\bctx\.redirect\b/u },
  { feature: "redirect()", pattern: /\bredirect\s*\(/u },
];

/** Context features a capability's handler source textually uses (sorted, deduped). */
export const detectContextFidelityFeatures = (source: string): string[] => {
  const features = new Set<string>();
  for (const { feature, pattern } of CONTEXT_FIDELITY_PATTERNS) {
    if (pattern.test(source)) {
      features.add(feature);
    }
  }
  return [...features].sort();
};

export type ContextFidelityViolation = { id: string; features: string[] };

export type ContextFidelityScan = {
  /** Catalog ids whose handler uses an un-honorable feature but is not waived. */
  violations: ContextFidelityViolation[];
  /** Waiver ids whose handler no longer uses any un-honorable feature (remove them). */
  staleWaivers: string[];
};

/**
 * Class-guard scan: every catalog capability whose handler source reaches for an
 * un-honorable context feature must be listed in the waiver table (id ->
 * justification) or the export fails. A waiver whose handler no longer trips the
 * scan is stale clutter and is reported too, so the table only documents real
 * refusals.
 */
export const scanContextFidelity = ({
  entries,
  waivedIds,
}: {
  entries: readonly { id: string; source: string }[];
  waivedIds: ReadonlySet<string>;
}): ContextFidelityScan => {
  const violations: ContextFidelityViolation[] = [];
  const tripped = new Set<string>();
  for (const { id, source } of entries) {
    const features = detectContextFidelityFeatures(source);
    if (features.length === 0) {
      continue;
    }
    tripped.add(id);
    if (!waivedIds.has(id)) {
      violations.push({ id, features });
    }
  }
  const staleWaivers = [...waivedIds].filter((id) => !tripped.has(id)).sort();
  violations.sort((a, b) => a.id.localeCompare(b.id));
  return { violations, staleWaivers };
};

export type ScopeComparison =
  | "equal"
  | "first-stricter"
  | "second-stricter"
  | "incomparable"
  | "unknown";

/**
 * Compare two MCP scopes under an explicit strictness-tier table (the exporter
 * owns the table; scopes are independent OAuth grants with no inherent
 * hierarchy, so comparability is a reviewed decision). Different tiers are
 * comparable (higher tier = stricter consent); different scopes at the same
 * tier are incomparable; a scope missing from the table is unknown. Both
 * non-comparable outcomes are fail-closed at the call site.
 */
export const compareScopeStrictness = ({
  first,
  second,
  tiers,
}: {
  first: string;
  second: string;
  tiers: Record<string, number>;
}): ScopeComparison => {
  if (first === second) {
    return "equal";
  }
  const firstTier = tiers[first];
  const secondTier = tiers[second];
  if (firstTier === undefined || secondTier === undefined) {
    return "unknown";
  }
  if (firstTier === secondTier) {
    return "incomparable";
  }
  return firstTier > secondTier ? "first-stricter" : "second-stricter";
};

export type ScopeResolution =
  | { status: "resolved"; scope: string }
  | { status: "acknowledged-unmapped" }
  | { status: "unmapped" };

/**
 * Resolve the MCP OAuth scope for a domain. A domain must either map to an
 * existing scope or be explicitly acknowledged as unmappable; an unknown domain
 * fails the export so a new domain cannot ship without a scope decision.
 */
export const resolveScope = ({
  domain,
  scopeTable,
  unmappedDomains,
}: {
  domain: string;
  scopeTable: Record<string, string>;
  unmappedDomains: ReadonlySet<string>;
}): ScopeResolution => {
  const scope = scopeTable[domain];
  if (scope !== undefined) {
    return { status: "resolved", scope };
  }
  if (unmappedDomains.has(domain)) {
    return { status: "acknowledged-unmapped" };
  }
  return { status: "unmapped" };
};
