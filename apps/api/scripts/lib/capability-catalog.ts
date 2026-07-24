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

/**
 * The one legal shape for a capability-id segment: lowercase kebab-case. Ids are
 * PUBLIC — the CLI derives its command path from them and MCP's
 * `invoke_capability` takes them verbatim — so they must never leak an internal
 * identifier. `deriveCapabilityId` suffixes a NAMED export's identifier, which is
 * a TS identifier and therefore camelCase; that is exactly how ids such as
 * `workspaces.anonymization-terms.deleteWorkspaceAnonymizationTerm` were minted.
 * Enforcing this pattern over every segment makes that class of id impossible:
 * a capability endpoint must live in its own kebab-case-named file and be the
 * file's DEFAULT export, so the id is derived purely from the handler path.
 */
export const CAPABILITY_ID_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Whether every `.`-separated segment of an id is lowercase kebab-case. */
export const isWellFormedCapabilityId = (id: string): boolean => {
  const segments = id.split(".");
  return (
    segments.length > 1 &&
    segments.every((segment) => CAPABILITY_ID_SEGMENT_PATTERN.test(segment))
  );
};

/** Ids failing `isWellFormedCapabilityId`, sorted (empty when all are well-formed). */
export const findMalformedCapabilityIds = (ids: readonly string[]): string[] =>
  ids.filter((id) => !isWellFormedCapabilityId(id)).sort();

/** The domain of a capability id: its first `.`-separated segment. */
export const deriveDomain = (id: string): string => {
  const domain = id.split(".").at(0);
  if (domain === undefined || domain.length === 0) {
    return panic(`capability-catalog: cannot derive a domain from id "${id}"`);
  }
  return domain;
};

/**
 * The canonical action verbs. A capability id's FINAL segment names the action;
 * `list` (a collection) and `get` (one entity by id) are deliberately split so
 * the surface can never repeat the old ambiguous `read`, which meant "list many"
 * in some domains and "fetch one" in others.
 */
export const CANONICAL_ACTION_VERBS = new Set([
  "list",
  "get",
  "create",
  "update",
  "delete",
]);

/**
 * Reviewed domain-specific action verbs: operations that are genuinely not CRUD
 * (`search`, `run`, `export-csv`, …). This list is an explicit review gate, not
 * a free-for-all: a capability whose action verb is in neither
 * `CANONICAL_ACTION_VERBS` nor this set fails the export, so a new
 * non-conforming verb cannot land silently. It is ratcheted (see
 * `capability-domain-action-verbs` in `scripts/ratchet.ts`) and may only shrink
 * as compound verbs are restructured into nested resources — e.g.
 * `clauses.categories-create` should become `clauses.categories.create`, which
 * needs no allowlist entry at all.
 */
export const DOMAIN_ACTION_VERBS = new Set([
  "add-entries",
  "approve",
  "archive",
  "assignees-add",
  "assignees-remove",
  "auto-run",
  "batch-delete",
  "batch-update",
  "binding-catalog",
  "boe-get-law",
  "boe-law-structure",
  "boe-related-laws",
  "boe-search",
  "boe-text-block",
  "borme-summary",
  "business-registries-lookup",
  "calendar",
  "categories-create",
  "categories-delete",
  "categories-list",
  "categories-update",
  "cell-retry",
  "check",
  "check-stamp",
  "clause-slots",
  "clauses-link",
  "clauses-list",
  "clauses-slot-update",
  "clauses-sync",
  "clauses-sync-all",
  "clauses-unlink",
  "clip",
  "clone-builtin",
  "compare-versions",
  "convert",
  "copy-to-workspace",
  "create-batch",
  "create-blank",
  "create-blank-document",
  "create-from-editor",
  "create-from-legal-source",
  "create-from-style-set",
  "create-from-styles",
  "delete-thread",
  "delete-version",
  "discover",
  "download",
  "download-zip",
  "duplicate",
  "entity-links-create",
  "entity-links-delete",
  "entity-links-read",
  "entries-create",
  "entries-delete",
  "entries-read",
  "entries-update",
  "export",
  "export-csv",
  "export-ledes",
  "export-pdf",
  "export-view",
  "fill",
  "fill-by-id",
  "fill-preview",
  "fill-to-workspace",
  "from-blueprint",
  "from-starter",
  "generate",
  "generate-draft",
  "get-entitlement",
  "get-messages",
  "get-older-messages",
  "get-threads",
  "import",
  "import-url",
  "install-skill",
  "list-catalogue",
  "list-commands",
  "list-exports",
  "list-files",
  "list-folders",
  "list-starters",
  "list-templates",
  "list-versions",
  "lookup-preview",
  "manifest",
  "mark-column-flag",
  "move",
  "organize-suggestions",
  "prefill",
  "prepare",
  "preview",
  "read-ai-availability",
  "read-anonymization-blacklist",
  "read-deepl-availability",
  "read-editor",
  "read-export",
  "read-filesystem-tree",
  "read-justifications",
  "read-stella-editor",
  "read-summaries",
  "read-summaries-count",
  "read-version",
  "read-version-by-id",
  "read-versions",
  "read-window",
  "read-workflow-status",
  "read-workflow-target-count",
  "remove-entries",
  "rename",
  "rename-thread",
  "reorder",
  "replace",
  "resolve",
  "restore-version",
  "review",
  "rewrite",
  "run",
  "run-cancel",
  "run-detail",
  "run-list",
  "run-review",
  "run-start",
  "save-document",
  "search",
  "seed",
  "split",
  "status",
  "suggest-fields",
  "suggest-prompt",
  "table-export",
  "template-slot-preview",
  "timer-start",
  "timer-stop",
  "transition",
  "translate",
  "unarchive",
  "update-anonymization-blacklist",
  "update-cell-metadata",
  "update-from-editor",
  "update-practice-jurisdictions",
  "update-thread",
  "update-version-description",
  "update-version-label",
  "upload",
  "upload-version",
  "upsert-by-id",
  "variants-create",
  "variants-delete",
  "variants-list",
  "variants-update",
  "version-diff",
  "version-summarize",
  "versions-diff",
  "versions-get",
  "versions-list",
  "versions-restore",
  "versions-summarize",
  "workflow-start",
  "workspace-contacts-create",
  "workspace-contacts-delete",
  "workspace-members-add",
  "workspace-members-remove",
]);

/** The action a capability id names: its final `.`-separated segment. */
export const deriveActionVerb = (id: string): string =>
  id.split(".").at(-1) ?? id;

/** Whether a capability id's action verb is canonical or a reviewed domain verb. */
export const isAllowedActionVerb = (id: string): boolean => {
  const verb = deriveActionVerb(id);
  return CANONICAL_ACTION_VERBS.has(verb) || DOMAIN_ACTION_VERBS.has(verb);
};

/** Ids whose action verb is in neither allowed set, sorted (empty when all conform). */
export const findNonConformingActionVerbs = (
  ids: readonly string[],
): string[] => ids.filter((id) => !isAllowedActionVerb(id)).sort();

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
 *  - an explicit ACCESS_OVERRIDES entry (id -> classification) wins over every
 *    heuristic: it is a reviewed decision, needed both for unclassifiable
 *    verbs AND for re-pinning a read that the verb derivation misclassifies as
 *    write (a read gated by its resource's write/update verb because no read
 *    verb exists, e.g. `usage.get-entitlement` under
 *    `organizationSettings:["update"]`);
 *  - otherwise handlers with permissions derive from their verbs; an
 *    unclassifiable verb fails, requiring an override;
 *  - handlers without permissions (session/token/public) default to read only
 *    when the final id segment looks like a getter (get/list/read prefix),
 *    otherwise require an override;
 *  - a resolved entry whose final id segment starts with delete/remove is
 *    escalated to destructive (deletes authorized via an `update` verb would
 *    otherwise come out non-destructive) unless the id is in
 *    `destructiveNameOptOuts` (reviewed false positives, e.g. an unlink that
 *    destroys nothing). The escalation applies to overrides too, so a re-pin
 *    can never silently drop the destructive flag off a delete-named id.
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
  if (override) {
    return escalate({ status: "resolved", ...override });
  }
  if (hasPermissions) {
    const classified = classifyVerbs(verbs);
    if (classified.ok) {
      return escalate({ status: "resolved", ...classified.value });
    }
    return {
      status: "needs-override",
      reason: `unclassifiable permission verb(s): ${classified.unknownVerbs.join(", ")}`,
    };
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
 * Per-segment allowlists for every value interpolated into the generated
 * dispatch module. Each derived value (id, import path, export name) is split
 * into its atomic segments and every segment is re-derived from a strict
 * allowlist match; the emitted value is then REBUILT from those matched pieces
 * (`rebuildFromSegments`). A crafted segment fails the match and the serializer
 * throws. Because the emitted string is assembled only from regex-match output
 * (never the raw input), the flow from a handler file path into generated
 * `import(...)` code visibly passes through sanitization — no tainted value
 * reaches code construction. Combined with `JSON.stringify` on the rebuilt
 * value, nothing a crafted handler path or export name contains can alter the
 * generated module's structure.
 *
 * - id: dot-joined lowercase kebab-case path segments (e.g.
 *   `workspaces.anonymization-terms.delete`), reusing
 *   `CAPABILITY_ID_SEGMENT_PATTERN` so the emitted dispatch keys cannot drift
 *   from the catalog's id shape; segments allow no dots at all (the id is split
 *   ON dots, so an empty segment already fails), which structurally rules out
 *   `.`/`..` shapes.
 * - import path: the fixed `@/api/` alias prefix plus lowercase path segments;
 *   a segment must start and end with an alphanumeric, so a dots-only segment
 *   (`.`, `..`, `...` — the path-traversal shape) can never round-trip into the
 *   emitted `import(...)` specifier.
 * - export name: a single plain TS identifier (no dots representable).
 */
const DISPATCH_ID_SEGMENT_PATTERN = CAPABILITY_ID_SEGMENT_PATTERN;
const DISPATCH_IMPORT_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const DISPATCH_EXPORT_NAME_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u;
const DISPATCH_IMPORT_PREFIX = "@/api/";

/**
 * Return the regex match for a single segment, or panic. The returned value is
 * the matched text (`match[0]`), so callers that rebuild from it are provably
 * working with allowlisted input rather than the raw (possibly tainted) source.
 */
const matchSafeSegment = ({
  segment,
  pattern,
  kind,
  id,
}: {
  segment: string;
  pattern: RegExp;
  kind: string;
  id: string;
}): string => {
  const match = pattern.exec(segment);
  if (match === null) {
    return panic(
      `capability-catalog: refusing to emit dispatch entry "${id}" with unsafe ${kind} segment ${JSON.stringify(segment)} (must match ${pattern})`,
    );
  }
  return match[0];
};

/** Rebuild a dispatch id from per-segment-validated pieces (dot-joined). */
const sanitizeDispatchId = (id: string): string =>
  id
    .split(".")
    .map((segment) =>
      matchSafeSegment({
        segment,
        pattern: DISPATCH_ID_SEGMENT_PATTERN,
        kind: "id",
        id,
      }),
    )
    .join(".");

/**
 * Rebuild an import specifier from the fixed `@/api/` prefix plus
 * per-segment-validated path pieces, so the value emitted into `import(...)`
 * derives only from allowlisted segments.
 */
const sanitizeImportSpecifier = ({
  importPath,
  id,
}: {
  importPath: string;
  id: string;
}): string => {
  if (!importPath.startsWith(DISPATCH_IMPORT_PREFIX)) {
    return panic(
      `capability-catalog: refusing to emit dispatch entry "${id}" with unsafe import path ${JSON.stringify(importPath)} (must start with ${DISPATCH_IMPORT_PREFIX})`,
    );
  }
  const segments = importPath
    .slice(DISPATCH_IMPORT_PREFIX.length)
    .split("/")
    .map((segment) =>
      matchSafeSegment({
        segment,
        pattern: DISPATCH_IMPORT_SEGMENT_PATTERN,
        kind: "import path",
        id,
      }),
    );
  return `${DISPATCH_IMPORT_PREFIX}${segments.join("/")}`;
};

/** Validate a single-identifier export name and return the matched text. */
const sanitizeExportName = ({
  exportName,
  id,
}: {
  exportName: string;
  id: string;
}): string =>
  matchSafeSegment({
    segment: exportName,
    pattern: DISPATCH_EXPORT_NAME_PATTERN,
    kind: "export name",
    id,
  });

/**
 * Serialize the generated capability-dispatch module: a typed map from
 * capability id to a lazy `import()` thunk (plus the export name for a non-
 * default export). Same determinism contract as the JSON catalog: the caller
 * passes id-sorted records. The server reads `.load()` then the named (or
 * default) export to reach the `{ config, handler }` endpoint definition, so the
 * generic invoke path runs the exact code REST does.
 *
 * Every interpolated value is rebuilt from per-segment allowlist matches (see
 * `sanitizeDispatchId` / `sanitizeImportSpecifier` / `sanitizeExportName`) and
 * emitted through `JSON.stringify`, so the generated code's structure cannot be
 * influenced by a crafted handler path or export name. The output is raw (single-
 * line entries); the exporter formats it with oxfmt before writing/comparing,
 * mirroring how the CLI codegen formats its generated modules, so the committed
 * artifact passes `oxfmt --check`.
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
      // Rebuild every interpolated value from allowlist-matched segments before
      // it reaches the generated code (see the sanitizers above).
      const id = sanitizeDispatchId(record.id);
      const importPath = sanitizeImportSpecifier({
        importPath: record.importPath,
        id: record.id,
      });
      const exportName =
        record.exportName === undefined
          ? undefined
          : sanitizeExportName({
              exportName: record.exportName,
              id: record.id,
            });
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
  return [...features].toSorted();
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

// --- File-input schema detection --------------------------------------------

/**
 * Whether a live config schema (an Elysia `t.*` TypeBox object) contains a
 * binary/file field anywhere. `t.File()` serializes as
 * `{ type: "string", format: "binary" }` (and `t.Files()` as an array of the
 * same), so a recursive walk for `format: "binary"` mechanically identifies
 * every file-input field, however deeply nested. Used to derive the catalog's
 * `requiresFileInput` flag: the generic invoke path validates JSON, where a
 * plain string passes `Value.Check` for a `format: "binary"` string schema but
 * the handler expects a `File`; flagged capabilities are refused at invoke and
 * routed to the presigned-upload flow. Derived, never hand-listed, so it is
 * stale-proof by construction. Walks enumerable properties only (TypeBox symbol
 * metadata never carries schema structure).
 */
export const schemaContainsBinaryFormat = (schema: unknown): boolean => {
  if (Array.isArray(schema)) {
    return schema.some(schemaContainsBinaryFormat);
  }
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  const record: Record<string, unknown> = { ...schema };
  if (record["format"] === "binary") {
    return true;
  }
  return Object.values(record).some(schemaContainsBinaryFormat);
};

// --- File-response scan (fix-6) ---------------------------------------------

/**
 * Whether a handler's success path returns a file-like value constructed
 * inline: `Result.ok(new Response(...))` (file/stream export) or
 * `Result.ok(new Uint8Array(...))` / `Result.ok(new Blob(...))` (raw binary
 * payload). This catches the common export shapes as a hard class guard. A
 * handler that returns one via an intermediate variable (e.g. `templates.fill`
 * delegating to a helper, or `time-entries.export-pdf` building its bytes in a
 * helper) is not matched here; it is seeded manually into the flag table and
 * kept honest by the stale check below (`constructsBinaryLike`).
 */
export const returnsInlineFileResponse = (source: string): boolean =>
  /Result\.ok\(\s*new (?:Response|Uint8Array|Blob)\b/su.test(source);

/**
 * Whether a handler constructs or names any file-like value — a web `Response`,
 * `Uint8Array`/`ArrayBuffer` bytes, a `Blob`, or a `ReadableStream`. Stale-check
 * signal only (keeps the flag table honest); the refusal itself keys off the
 * flag plus the runtime backstop in `mapHandlerResult`.
 */
export const constructsBinaryLike = (source: string): boolean =>
  /\bnew Response\s*\(|\bUint8Array\b|\bArrayBuffer\b|\bnew Blob\s*\(|\bReadableStream\b/u.test(
    source,
  );

export type FileResponseScan = {
  /** Catalog ids whose success path inline-returns a file-like value but are not flagged. */
  violations: string[];
  /** Flagged ids whose handler no longer constructs any file-like value (remove them). */
  staleFlags: string[];
};

/**
 * Class guard for capabilities whose success payload is a file: a web
 * `Response` or raw binary bytes. The generic invoke path cannot serialize
 * either, so each must be flagged (carried into the catalog as
 * `returnsFileResponse` and refused at invoke). Any catalog handler whose
 * success path inline-returns one but is unflagged is a violation; a flagged id
 * whose handler no longer constructs any file-like value is stale.
 */
export const scanFileResponseReturns = ({
  entries,
  flaggedIds,
}: {
  entries: readonly { id: string; source: string }[];
  flaggedIds: ReadonlySet<string>;
}): FileResponseScan => {
  const violations: string[] = [];
  const sourceById = new Map(entries.map(({ id, source }) => [id, source]));
  for (const { id, source } of entries) {
    if (!flaggedIds.has(id) && returnsInlineFileResponse(source)) {
      violations.push(id);
    }
  }
  const staleFlags: string[] = [];
  for (const id of flaggedIds) {
    const source = sourceById.get(id);
    if (source === undefined || !constructsBinaryLike(source)) {
      staleFlags.push(id);
    }
  }
  return {
    violations: violations.sort(),
    staleFlags: staleFlags.sort(),
  };
};

// --- Route-hook guard scan (fix-2) ------------------------------------------

/**
 * Route-level pre-handler hooks (`onBeforeHandle` / `beforeHandle`) that gate a
 * mounted endpoint. The generic invoke path calls the handler directly, so any
 * authorization such a hook adds is bypassed unless it also lives in the handler
 * config. This detects capability endpoints mounted under such a hook so each is
 * either fixed (gate moved into the handler) or explicitly waived.
 */
const ROUTE_HOOK_PATTERN = /\.(?:onBeforeHandle|beforeHandle)\s*\(/u;
const ROUTE_HANDLER_MOUNT_PATTERN =
  /\b(?<local>[A-Za-z_$][\w$]*)\.(?:default\.)?handler\b/gu;
const ROUTE_IMPORT_STATEMENT =
  /import\s+(?<clause>[^;]+?)\s+from\s+["'](?<path>@\/api\/handlers\/[^"']+)["']/gu;
const IDENTIFIER_HEAD = /^(?<name>[A-Za-z_$][\w$]*)/u;
const NAMED_IMPORT_BLOCK = /\{(?<body>[^}]*)\}/u;
const ALIASED_IMPORT =
  /^(?<orig>[A-Za-z_$][\w$]*)\s+as\s+(?<alias>[A-Za-z_$][\w$]*)$/u;
const PLAIN_IDENTIFIER = /^(?<name>[A-Za-z_$][\w$]*)$/u;
const HANDLER_IMPORT_ALIAS_PREFIX = "@/api/";
const HANDLER_ALIAS_TO_SRC_PREFIX = "apps/api/src/";

type ImportedLocal = { importPath: string; exportName: string | undefined };

/** Map each locally-bound handler name to its module import path + export name. */
const parseHandlerImports = (source: string): Map<string, ImportedLocal> => {
  const map = new Map<string, ImportedLocal>();
  for (const match of source.matchAll(ROUTE_IMPORT_STATEMENT)) {
    const clause = match.groups?.["clause"]?.trim() ?? "";
    const importPath = match.groups?.["path"] ?? "";
    if (!clause.startsWith("{")) {
      const defaultName = IDENTIFIER_HEAD.exec(clause)?.groups?.["name"];
      if (defaultName !== undefined) {
        map.set(defaultName, { importPath, exportName: undefined });
      }
    }
    const namedBody = NAMED_IMPORT_BLOCK.exec(clause)?.groups?.["body"];
    if (namedBody !== undefined) {
      for (const part of namedBody.split(",")) {
        const trimmed = part.trim();
        if (trimmed.length === 0) {
          continue;
        }
        const aliased = ALIASED_IMPORT.exec(trimmed)?.groups;
        if (aliased?.["orig"] !== undefined && aliased["alias"] !== undefined) {
          map.set(aliased["alias"], {
            importPath,
            exportName: aliased["orig"],
          });
          continue;
        }
        const plain = PLAIN_IDENTIFIER.exec(trimmed)?.groups?.["name"];
        if (plain !== undefined) {
          map.set(plain, { importPath, exportName: plain });
        }
      }
    }
  }
  return map;
};

/** Capability id for a route-imported handler (`@/api/handlers/x/y` -> `x.y`). */
const importToCapabilityId = ({
  importPath,
  exportName,
}: ImportedLocal): string | undefined => {
  if (!importPath.startsWith(`${HANDLER_IMPORT_ALIAS_PREFIX}handlers/`)) {
    return undefined;
  }
  const file = `${importPath.replace(
    HANDLER_IMPORT_ALIAS_PREFIX,
    () => HANDLER_ALIAS_TO_SRC_PREFIX,
  )}.ts`;
  return deriveCapabilityId({ file, exportName });
};

/** Capability ids mounted under a hooked Elysia instance in one route file. */
const hookGuardedIdsInFile = ({
  source,
  capabilityIds,
}: {
  source: string;
  capabilityIds: ReadonlySet<string>;
}): Set<string> => {
  const imports = parseHandlerImports(source);
  const guarded = new Set<string>();
  // Each `const x = new Elysia(...)...` chain is one block; a hook applies to
  // routes chained on the same instance, so scan per block.
  for (const block of source.split(/(?=new Elysia\s*\()/u)) {
    if (!ROUTE_HOOK_PATTERN.test(block)) {
      continue;
    }
    for (const mount of block.matchAll(ROUTE_HANDLER_MOUNT_PATTERN)) {
      const local = mount.groups?.["local"];
      const imported = local === undefined ? undefined : imports.get(local);
      const id =
        imported === undefined ? undefined : importToCapabilityId(imported);
      if (id !== undefined && capabilityIds.has(id)) {
        guarded.add(id);
      }
    }
  }
  return guarded;
};

export type RouteHookGuardViolation = { routeFile: string; id: string };

export type RouteHookGuardScan = {
  /** Hook-guarded capability endpoints that are not waived. */
  violations: RouteHookGuardViolation[];
  /** Waiver ids no longer mounted under any route hook (remove them). */
  staleWaivers: string[];
};

/**
 * Scan route files for capability endpoints wrapped in a route-level
 * `onBeforeHandle`/`beforeHandle` hook that the generic invoke path would
 * bypass. Each hit must be waived (id -> justification, the gate lives in the
 * handler config) or the export fails; a waiver no longer matched is stale.
 */
export const scanRouteHookGuards = ({
  routeFiles,
  capabilityIds,
  waivedIds,
}: {
  routeFiles: readonly { id: string; source: string }[];
  capabilityIds: ReadonlySet<string>;
  waivedIds: ReadonlySet<string>;
}): RouteHookGuardScan => {
  const violations: RouteHookGuardViolation[] = [];
  const detected = new Set<string>();
  for (const { id: routeFile, source } of routeFiles) {
    for (const id of hookGuardedIdsInFile({ source, capabilityIds })) {
      detected.add(id);
      if (!waivedIds.has(id)) {
        violations.push({ routeFile, id });
      }
    }
  }
  const staleWaivers = [...waivedIds].filter((id) => !detected.has(id)).sort();
  violations.sort(
    (a, b) =>
      a.id.localeCompare(b.id) || a.routeFile.localeCompare(b.routeFile),
  );
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

/**
 * The six write-only OAuth grants. A capability whose `access` is `read` must
 * never resolve to one of these — a read-only credential (`stella:read` /
 * `stella:admin_read`) would then be unable to invoke it. Enforced structurally
 * by the exporter's read-scope guard AND the `read-capabilities-with-write-scope`
 * ratchet, so the class stays impossible even if the resolver is later changed.
 */
export const WRITE_ONLY_SCOPES: ReadonlySet<string> = new Set([
  "stella:admin_write",
  "stella:billing_write",
  "stella:contacts_write",
  "stella:documents_write",
  "stella:knowledge_write",
  "stella:matters_write",
]);

/**
 * The read-tier scope a domain's write/consent scope downgrades to for a READ
 * capability. The write-tiered buckets each pair with the read grant their
 * curated read tools already use: the workspace/billing/knowledge/document
 * write buckets all read under `stella:read`, and the admin write bucket reads
 * under `stella:admin_read`. A scope that is not a write-tiered bucket (already
 * a read/consent grant such as `stella:read`, `stella:chat`, `stella:skills`,
 * `stella:templates`, `stella:admin_read`, ...) maps to itself: read == write
 * there, and that is correct.
 */
const READ_SCOPE_BY_DOMAIN_SCOPE: Record<string, string> = {
  "stella:admin_write": "stella:admin_read",
  "stella:billing_write": "stella:read",
  "stella:contacts_write": "stella:read",
  "stella:documents_write": "stella:read",
  "stella:knowledge_write": "stella:read",
  "stella:matters_write": "stella:read",
};

/**
 * The read-tier scope for a domain's (or entry override's) write/consent scope.
 * Write-tiered buckets downgrade per `READ_SCOPE_BY_DOMAIN_SCOPE`; every other
 * scope is its own read scope.
 */
export const readScopeForDomainScope = (domainScope: string): string =>
  READ_SCOPE_BY_DOMAIN_SCOPE[domainScope] ?? domainScope;

export type ScopeResolution =
  | { status: "resolved"; readScope: string; writeScope: string }
  | { status: "acknowledged-unmapped" }
  | { status: "unmapped" };

/**
 * Resolve the MCP OAuth scope pair for a domain. The `scopeTable` value is the
 * domain's WRITE/consent scope; the read scope is derived from it
 * (`readScopeForDomainScope`), so scope resolves from (access, domain) rather
 * than domain alone: a read capability takes `readScope`, a write capability
 * `writeScope`. A domain must either map to an existing scope or be explicitly
 * acknowledged as unmappable; an unknown domain fails the export so a new domain
 * cannot ship without a scope decision.
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
  const writeScope = scopeTable[domain];
  if (writeScope !== undefined) {
    return {
      status: "resolved",
      readScope: readScopeForDomainScope(writeScope),
      writeScope,
    };
  }
  if (unmappedDomains.has(domain)) {
    return { status: "acknowledged-unmapped" };
  }
  return { status: "unmapped" };
};

// --- Coverage doc (generated docs/capability-coverage.md) -------------------

/** The `mcp` disposition shape a coverage-doc entry carries (mirrors CapabilityMcp). */
export type CoverageDocMcp =
  | { type: "tool"; name: string }
  | { type: "covered"; by: string }
  | { type: "capability"; reason: string };

/**
 * The subset of a built `CapabilityEntry` the coverage doc renders. Structural
 * (not the exporter's full `CapabilityEntry`), so this stays a pure function
 * over plain data with no import from the exporter or the handler graph.
 */
export type CoverageDocEntry = {
  id: string;
  access: "read" | "write";
  destructive: boolean;
  scope: string;
  feature?: string;
  requiresFileInput?: true;
  returnsFileResponse?: true;
  mcp: CoverageDocMcp;
};

const COVERAGE_DOC_HEADER = `<!-- GENERATED by apps/api/scripts/export-capability-catalog.ts — do not edit. -->
<!-- Regenerate: bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts -->

# Capability coverage

Every safe handler the API exposes, grouped by domain: how it is classified
(read/write, destructive) and how it is reachable — as a curated MCP tool,
covered by one, or only through the generic \`invoke_capability\` path (shown
here as its CLI form). Projected from the same handler enumeration that builds
\`apps/api/src/mcp/generated/capability-catalog.json\`; see
\`apps/api/scripts/export-capability-catalog.ts\`.
`;

/** Access column text: `read`, `write`, or `write, destructive`. */
const renderAccessCell = (entry: CoverageDocEntry): string =>
  entry.destructive ? `${entry.access}, destructive` : entry.access;

/**
 * "Reachable via" column text for one entry. `cliCommandPathById` carries the
 * REAL generated command path per capability id, computed by the exporter
 * through the CLI's own `buildCliRouteTree` (the same builder codegen uses), so
 * collision fallbacks (e.g. `legislation.search` relocated under
 * `stella capability legislation search`) render their actual invocation
 * instead of an id-derived guess. A capability-disposition entry missing from
 * the map is an exporter invariant violation (the map is built from the same
 * entries), so it panics rather than printing a wrong path.
 */
const renderReachableViaCell = (
  entry: CoverageDocEntry,
  cliCommandPathById: ReadonlyMap<string, readonly string[]>,
): string => {
  if (entry.mcp.type === "tool") {
    return `curated tool \`${entry.mcp.name}\``;
  }
  if (entry.mcp.type === "covered") {
    return `covered by \`${entry.mcp.by}\``;
  }
  if (entry.requiresFileInput || entry.returnsFileResponse) {
    return "generic invoke: file I/O — not runnable via CLI/JSON (describe only)";
  }
  const commandPath =
    cliCommandPathById.get(entry.id) ??
    panic(
      `coverage doc: no generated CLI command path for capability "${entry.id}"`,
    );
  return `generic invoke → \`stella ${commandPath.join(" ")}\``;
};

/** Render one domain's capability table (header row through the last entry). */
const renderDomainSection = ({
  domain,
  entries,
  cliCommandPathById,
}: {
  domain: string;
  entries: readonly CoverageDocEntry[];
  cliCommandPathById: ReadonlyMap<string, readonly string[]>;
}): string => {
  const rows = entries
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map(
      (entry) =>
        `| \`${entry.id}\` | ${renderAccessCell(entry)} | ${entry.scope} | ${entry.feature ?? "—"} | ${renderReachableViaCell(entry, cliCommandPathById)} |`,
    );
  return `## ${domain}

| Capability | Access | Scope | Feature | Reachable via |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
};

/** Render the trailing "Waived internal handlers" section from reason counts. */
const renderWaivedInternalSection = (
  internalWaiverCounts: Readonly<Record<string, number>>,
): string => {
  const reasons = Object.keys(internalWaiverCounts).sort((a, b) =>
    a.localeCompare(b),
  );
  const total = reasons.reduce(
    (sum, reason) => sum + (internalWaiverCounts[reason] ?? 0),
    0,
  );
  const rows = reasons.map(
    (reason) => `| ${reason} | ${internalWaiverCounts[reason]} |`,
  );
  return `## Waived internal handlers

Permanent \`internal\` MCP dispositions: handlers reviewed and deliberately
kept off the capability surface entirely (auth/token plumbing, transport
mechanics, and similar), not gaps in coverage.

| Reason | Count |
| --- | --- |
${rows.join("\n")}

Total: ${total}
`;
};

/**
 * Render the deterministic markdown coverage doc: one section per domain
 * (alphabetical, entries id-sorted within), then the waived-internal-handlers
 * summary. Pure projection of the built catalog entries, the per-capability
 * generated CLI command paths (from the CLI's own route-tree builder), and
 * internal-waiver reason counts; the exporter byte-compares this against the
 * committed `docs/capability-coverage.md` in `--check` mode, so the output must
 * be fully deterministic (stable sort, fixed column order, single trailing
 * newline).
 */
export const serializeCoverageDoc = ({
  entries,
  cliCommandPathById,
  internalWaiverCounts,
}: {
  entries: readonly CoverageDocEntry[];
  /** Capability id -> the REAL generated CLI command path (collision-aware). */
  cliCommandPathById: ReadonlyMap<string, readonly string[]>;
  internalWaiverCounts: Readonly<Record<string, number>>;
}): string => {
  const byDomain = new Map<string, CoverageDocEntry[]>();
  for (const entry of entries) {
    const domain = deriveDomain(entry.id);
    const bucket = byDomain.get(domain) ?? [];
    bucket.push(entry);
    byDomain.set(domain, bucket);
  }
  const domainSections = [...byDomain.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((domain) =>
      renderDomainSection({
        domain,
        entries: byDomain.get(domain) ?? [],
        cliCommandPathById,
      }),
    );

  return `${COVERAGE_DOC_HEADER}
${domainSections.join("\n")}
${renderWaivedInternalSection(internalWaiverCounts)}`;
};
