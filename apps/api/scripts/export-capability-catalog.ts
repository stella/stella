// Dev-only exporter: projects the safe-handler universe down to a capability
// catalog and writes a deterministic JSON snapshot
// (`apps/api/src/mcp/generated/capability-catalog.json`).
//
// A "capability" is any safe handler whose `mcp` disposition is `tool`,
// `covered`, or `capability` (an `internal` disposition is a permanent reviewed
// waiver, so it stays out of the catalog). Membership is derived from the
// disposition that already exists on every handler config; there is no new
// per-handler annotation. The `mcp` field on each entry carries the disposition
// through (`tool`/`covered` name their curated tool; `capability` names its
// reason). Each entry is
// a pure projection of the handler's config: id (from the file path), input JSON
// Schema (`body`/`params`/`query`, TypeBox symbols stripped by a JSON round
// trip), permissions, handler-scope kind, access (read/write) + destructive
// flag, and the MCP OAuth scope for the capability's domain.
//
// The snapshot is compact JSON (id-sorted entries, no indentation), and each
// entry's input schema is capped at MAX_CAPABILITY_SCHEMA_BYTES: oversize
// schemas are omitted and the entry marked `inputSchemaTruncated` so the
// committed artifact stays reviewable (see CapabilityEntry).
//
// Modes:
//   bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts
//       regenerate the committed catalog JSON
//   bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts --check
//       drift guard: regenerate in-memory, byte-compare against the committed
//       JSON, exit 1 with a diff summary on mismatch
//
// Env-dependent by design (it imports the handler graph, which validates the API
// env at module load), so run under `bun --env-file=apps/api/.env`. Wired into
// `bun run verify` and CI next to the CLI registry-snapshot drift guard.

import { panic, Result } from "better-result";
import path from "node:path";

import {
  type AccessClassification,
  capInputSchema,
  type CapabilityInputSchema,
  deriveCapabilityId,
  deriveDomain,
  findInlineCapabilityMismatches,
  findStaleAccessOverrides,
  isDestructiveName,
  resolveAccess,
  resolveHandlerKind,
  resolveScope,
  serializeCatalog,
} from "./lib/capability-catalog";
import {
  discoverSafeHandlers,
  type HandlerKind,
  isRecord,
  type ParsedExposure,
  REPO_ROOT,
} from "./lib/enumerate-safe-handlers";

const CATALOG_PATH = path.resolve(
  REPO_ROOT,
  "apps/api/src/mcp/generated/capability-catalog.json",
);

/**
 * MCP OAuth scope per capability domain (the first id segment). One scope per
 * domain: writes reuse their domain's write consent bucket, read-only domains
 * map to the read/admin-read scope their curated tools already use. A domain
 * that appears in the catalog but is absent here (and from UNMAPPED_DOMAINS)
 * fails the export, so a new domain cannot ship without a scope decision. Every
 * value must be a real scope in `apps/api/src/mcp/constants.ts`.
 */
const DOMAIN_SCOPE: Record<string, string> = {
  "audit-logs": "stella:admin_read",
  "billing-codes": "stella:billing_write",
  catalogue: "stella:skills",
  // No dedicated chat/assistant consent scope exists; chat-thread CRUD is
  // workspace-scoped user content, so it reuses the workspace write bucket.
  chat: "stella:matters_write",
  clauses: "stella:knowledge_write",
  contacts: "stella:matters_write",
  "document-types": "stella:matters_write",
  entities: "stella:matters_write",
  expenses: "stella:billing_write",
  fields: "stella:matters_write",
  // Now carries invoice create/delete/transition capabilities, not just the
  // read tool, so it reuses the billing write bucket.
  invoices: "stella:billing_write",
  legislation: "stella:read",
  "organization-settings": "stella:admin_write",
  playbooks: "stella:knowledge_write",
  // Now carries property create/update/delete capabilities, so it reuses the
  // workspace write bucket rather than the read scope its read tool used.
  properties: "stella:matters_write",
  // Now carries rate-card create/update/delete capabilities, so it reuses the
  // billing write bucket rather than the read scope its resolution tool used.
  rates: "stella:billing_write",
  // Report export creates workspace entities / template records; reuse the
  // workspace write bucket.
  reports: "stella:matters_write",
  skills: "stella:skills",
  tasks: "stella:matters_write",
  "template-recipes": "stella:templates",
  templates: "stella:templates",
  "time-entries": "stella:billing_write",
  usage: "stella:read",
  "view-templates": "stella:matters_write",
  views: "stella:matters_write",
  workspaces: "stella:matters_write",
};

/**
 * Domains deliberately acknowledged as having no fitting existing scope. Empty:
 * every catalog domain maps to an existing scope. An entry here is reported by
 * the export (so the gap is visible) and its handlers are omitted from the
 * catalog rather than assigned an invented scope.
 */
const UNMAPPED_DOMAINS: ReadonlySet<string> = new Set<string>();

/**
 * Handler-scope kind for capabilities whose file mixes safe-handler factories,
 * so the export cannot attribute the kind from the file's single factory. Empty:
 * no handler file currently mixes factory kinds. A file that starts mixing them
 * fails the export until the ambiguous export is pinned here.
 */
const HANDLER_KIND_OVERRIDES: Record<string, HandlerKind> = {};

/**
 * Access classification for capabilities whose permission verbs cannot be
 * mechanically classified (verbs outside read/list/view/create/update/delete/
 * manage/write), or permissionless handlers whose name is not get/list/read.
 * Each entry is a reviewed decision; an unclassifiable handler absent here fails
 * the export. Kept tight by a stale-entry check (an id that no longer needs an
 * override fails).
 *
 * - `playbooks.run`: `playbook:["apply"]` — running a playbook produces a run
 *   record; treat as a (non-destructive) write.
 * - `playbooks.auto-run`: `playbook:["apply"]` — materializes playbook-run
 *   columns/properties over the files table, so write.
 * - `playbooks.approve`: `playbook:["approve"]` — snapshots a version and flips
 *   the definition status, so write.
 * - `playbooks.review`: `playbook:["apply"]` — ephemeral single-document grading
 *   that persists no fields/justifications (only an audit row) and returns
 *   findings inline, so read.
 * - `templates.fill` / `templates.fill-by-id`: `template:["use"]` — both persist
 *   a template-fill record, so write.
 * - `templates.fill-preview` / `templates.prefill`: `template:["use"]` — compute
 *   only, no persistence, so read.
 * - `templates.fill-to-workspace`: `template:["use"], entity:["create"]` —
 *   creates a workspace entity, so write.
 */
const ACCESS_OVERRIDES: Record<string, AccessClassification> = {
  "playbooks.run": { access: "write", destructive: false },
  "playbooks.auto-run": { access: "write", destructive: false },
  "playbooks.approve": { access: "write", destructive: false },
  "playbooks.review": { access: "read", destructive: false },
  "templates.fill": { access: "write", destructive: false },
  "templates.fill-by-id": { access: "write", destructive: false },
  "templates.fill-preview": { access: "read", destructive: false },
  "templates.prefill": { access: "read", destructive: false },
  "templates.fill-to-workspace": { access: "write", destructive: false },
};

/**
 * Reviewed opt-outs from the delete/remove name heuristic (see
 * `isDestructiveName`): capabilities whose final id segment starts with
 * delete/remove but that destroy nothing. Kept tight by a stale-entry check (an
 * entry the heuristic would not have escalated fails the export).
 *
 * - `invoices.remove-entries`: unlinks time entries/expenses from an invoice
 *   (`invoiceId: null`); the entries survive and return to the unbilled pool.
 */
const DESTRUCTIVE_NAME_OPT_OUTS: ReadonlySet<string> = new Set([
  "invoices.remove-entries",
]);

/**
 * Files with `capability`-annotated endpoints defined INLINE in route files
 * (mounted directly into Elysia, never exported as `{ config, handler }`).
 * These are known catalog GAPS: an inline endpoint cannot be enumerated, so its
 * capability is not projected into the catalog (nor invokable through the
 * generic path) until the handler is refactored into an endpoint module. Counts
 * are exact, so a NEW inline capability disposition fails the export instead of
 * silently vanishing from the catalog; shrink an entry when its file is
 * refactored. Companion to the coverage guard's INLINE_ENDPOINT_ALLOWLIST.
 */
const INLINE_CAPABILITY_ALLOWLIST: Record<string, number> = {
  "apps/api/src/handlers/case-law/routes.ts": 5,
  "apps/api/src/handlers/legislation/corpus-routes.ts": 2,
  "apps/api/src/handlers/time-entries/routes.ts": 3,
  "apps/api/src/handlers/workspaces/routes.ts": 2,
};

type CapabilityMcp =
  | { type: "tool"; name: string }
  | { type: "covered"; by: string }
  | { type: "capability"; reason: string };

type CapabilityEntry = {
  id: string;
  handlerKind: HandlerKind;
  access: "read" | "write";
  destructive: boolean;
  scope: string;
  permissions?: unknown;
  /**
   * Absent when the schema exceeded MAX_CAPABILITY_SCHEMA_BYTES (see
   * `inputSchemaTruncated`). The server always has the live schema from the
   * handler config; the snapshot omits oversize schemas to keep the committed
   * artifact reviewable.
   */
  inputSchema?: CapabilityInputSchema;
  /**
   * Set when `inputSchema` was omitted for size. Consumers must treat truncated
   * entries as input-only: the capability still accepts input (validated
   * server-side against the live handler schema), but the snapshot cannot
   * describe its shape.
   */
  inputSchemaTruncated?: true;
  mcp: CapabilityMcp;
};

// Project the parsed exposure onto the catalog's `mcp` shape. Only `tool`,
// `covered`, and `capability` reach here (the caller skips every other type
// before building an entry); anything else is a programmer error.
const toCapabilityMcp = (exposure: ParsedExposure): CapabilityMcp => {
  if (exposure.type === "tool") {
    return { type: "tool", name: exposure.name };
  }
  if (exposure.type === "covered") {
    return { type: "covered", by: exposure.by };
  }
  if (exposure.type === "capability") {
    return { type: "capability", reason: exposure.reason };
  }
  return panic(
    `export-capability-catalog: unexpected exposure type "${exposure.type}" in catalog build`,
  );
};

const extractVerbs = (permissions: unknown): string[] => {
  if (!isRecord(permissions)) {
    return [];
  }
  const verbs: string[] = [];
  for (const actions of Object.values(permissions)) {
    if (!Array.isArray(actions)) {
      continue;
    }
    for (const action of actions) {
      if (typeof action === "string") {
        verbs.push(action);
      }
    }
  }
  return verbs;
};

// The config's `body`/`params`/`query` are TypeBox schemas: plain JSON Schema
// objects at runtime plus non-enumerable symbol metadata. The final
// `JSON.stringify` of the whole catalog drops those symbols, leaving clean JSON
// Schema on disk, so the raw schema value can go straight into the entry.
const buildInputSchema = (
  config: Record<string, unknown>,
): CapabilityInputSchema => {
  const inputSchema: CapabilityInputSchema = {};
  if ("body" in config) {
    inputSchema.body = config["body"];
  }
  if ("params" in config) {
    inputSchema.params = config["params"];
  }
  if ("query" in config) {
    inputSchema.query = config["query"];
  }
  return inputSchema;
};

type BuildResult = {
  entries: CapabilityEntry[];
  errors: string[];
  /** Capability ids whose input schema was omitted for exceeding the byte cap. */
  truncatedSchemas: string[];
};

const buildCatalog = async (): Promise<BuildResult> => {
  const { endpoints, files, importErrors } = await discoverSafeHandlers();
  const errors: string[] = [];

  for (const { id, message } of importErrors) {
    errors.push(`import failed: ${id}: ${message}`);
  }

  const kindsByFile = new Map(files.map((file) => [file.id, file.kinds]));
  const entries: CapabilityEntry[] = [];
  const idToFile = new Map<string, string>();
  const presentDomains = new Set<string>();
  const accessOverrideUses: string[] = [];
  const kindOverrideUses: string[] = [];
  const optOutUses = new Set<string>();
  const truncatedSchemas: string[] = [];

  // Enumerable `capability` endpoints per file, for the inline-capability
  // invariant: any textual `capability` disposition beyond these is an inline
  // endpoint the catalog cannot see.
  const enumerableCapabilityByFile = new Map<string, number>();
  for (const endpoint of endpoints) {
    if (endpoint.exposure.type !== "capability") {
      continue;
    }
    enumerableCapabilityByFile.set(
      endpoint.file,
      (enumerableCapabilityByFile.get(endpoint.file) ?? 0) + 1,
    );
  }
  const inlineMismatches = findInlineCapabilityMismatches({
    files: files.map(({ id, source }) => ({
      id,
      source,
      enumerableCapabilityCount: enumerableCapabilityByFile.get(id) ?? 0,
    })),
    allowlist: INLINE_CAPABILITY_ALLOWLIST,
  });
  for (const { id, inlineCount, allowed } of inlineMismatches) {
    errors.push(
      `inline capability endpoints in ${id}: ${inlineCount} inline \`capability\` disposition(s) but ${allowed} allowlisted. Inline endpoints cannot be projected into the catalog; refactor them into \`{ config, handler }\` endpoint modules (or, for the pre-existing pinned gaps only, update INLINE_CAPABILITY_ALLOWLIST)`,
    );
  }
  const discoveredFiles = new Set(files.map(({ id }) => id));
  for (const id of Object.keys(INLINE_CAPABILITY_ALLOWLIST)) {
    if (!discoveredFiles.has(id)) {
      errors.push(
        `stale INLINE_CAPABILITY_ALLOWLIST entry "${id}": file no longer discovered (remove it so it cannot admit future inline capabilities)`,
      );
    }
  }

  for (const endpoint of endpoints) {
    if (
      endpoint.exposure.type !== "tool" &&
      endpoint.exposure.type !== "covered" &&
      endpoint.exposure.type !== "capability"
    ) {
      continue;
    }
    const id = deriveCapabilityId({
      file: endpoint.file,
      exportName: endpoint.exportName,
    });
    const existing = idToFile.get(id);
    if (existing !== undefined) {
      errors.push(
        `duplicate capability id "${id}" from ${existing} and ${endpoint.file}`,
      );
      continue;
    }
    idToFile.set(id, endpoint.file);

    const domain = deriveDomain(id);
    presentDomains.add(domain);

    const kinds = kindsByFile.get(endpoint.file) ?? [];
    const kindResolution = resolveHandlerKind({
      id,
      kinds,
      overrides: HANDLER_KIND_OVERRIDES,
    });
    if (id in HANDLER_KIND_OVERRIDES) {
      kindOverrideUses.push(id);
    }

    const permissions = endpoint.config["permissions"];
    const hasPermissions = "permissions" in endpoint.config;
    const verbs = extractVerbs(permissions);
    const accessResolution = resolveAccess({
      id,
      verbs,
      hasPermissions,
      overrides: ACCESS_OVERRIDES,
      destructiveNameOptOuts: DESTRUCTIVE_NAME_OPT_OUTS,
    });
    if (
      DESTRUCTIVE_NAME_OPT_OUTS.has(id) &&
      accessResolution.status === "resolved" &&
      isDestructiveName(id) &&
      !accessResolution.destructive
    ) {
      // The opt-out changed the outcome (the name heuristic would have
      // escalated, and the verbs did not already make it destructive).
      optOutUses.add(id);
    }
    if (accessResolution.status === "resolved" && id in ACCESS_OVERRIDES) {
      // Only counts as "used" when the override was actually consulted — a
      // classifiable handler ignores its override, so it stays reportable.
      const classifiable =
        hasPermissions &&
        verbs.length > 0 &&
        resolveAccess({ id, verbs, hasPermissions, overrides: {} }).status ===
          "resolved";
      if (!classifiable) {
        accessOverrideUses.push(id);
      }
    }

    const scopeResolution = resolveScope({
      domain,
      scopeTable: DOMAIN_SCOPE,
      unmappedDomains: UNMAPPED_DOMAINS,
    });

    if (kindResolution.status === "needs-override") {
      errors.push(
        `handlerKind override required for "${id}": ${kindResolution.reason}`,
      );
    }
    if (accessResolution.status === "needs-override") {
      errors.push(
        `access override required for "${id}": ${accessResolution.reason}`,
      );
    }
    if (scopeResolution.status === "unmapped") {
      errors.push(
        `domain "${domain}" (capability "${id}") maps to no scope; add it to DOMAIN_SCOPE or UNMAPPED_DOMAINS`,
      );
    }
    if (scopeResolution.status === "acknowledged-unmapped") {
      // Omitted from the catalog by design; reported so the gap stays visible.
      errors.push(
        `domain "${domain}" (capability "${id}") is in UNMAPPED_DOMAINS: no scope, capability omitted`,
      );
    }

    if (
      kindResolution.status !== "resolved" ||
      accessResolution.status !== "resolved" ||
      scopeResolution.status !== "resolved"
    ) {
      continue;
    }

    const capped = capInputSchema(buildInputSchema(endpoint.config));
    if (capped.truncated) {
      truncatedSchemas.push(id);
    }
    const entry: CapabilityEntry = {
      id,
      handlerKind: kindResolution.kind,
      access: accessResolution.access,
      destructive: accessResolution.destructive,
      scope: scopeResolution.scope,
      ...(hasPermissions ? { permissions } : {}),
      ...(capped.truncated
        ? { inputSchemaTruncated: true as const }
        : { inputSchema: capped.inputSchema }),
      mcp: toCapabilityMcp(endpoint.exposure),
    };
    entries.push(entry);
  }

  // Keep the mapping/override tables honest: a table entry that no longer
  // applies is fail-open clutter, so a stale entry fails the export.
  const staleAccess = findStaleAccessOverrides({
    overrides: ACCESS_OVERRIDES,
    usedIds: accessOverrideUses,
  });
  for (const id of staleAccess) {
    errors.push(
      `stale ACCESS_OVERRIDES entry "${id}": it no longer needs an override (remove it)`,
    );
  }
  for (const id of Object.keys(HANDLER_KIND_OVERRIDES)) {
    if (!kindOverrideUses.includes(id)) {
      errors.push(
        `stale HANDLER_KIND_OVERRIDES entry "${id}": no ambiguous handler file uses it (remove it)`,
      );
    }
  }
  for (const id of DESTRUCTIVE_NAME_OPT_OUTS) {
    if (!optOutUses.has(id)) {
      errors.push(
        `stale DESTRUCTIVE_NAME_OPT_OUTS entry "${id}": the delete/remove name heuristic would not escalate it (remove it)`,
      );
    }
  }
  for (const domain of Object.keys(DOMAIN_SCOPE)) {
    if (!presentDomains.has(domain)) {
      errors.push(
        `stale DOMAIN_SCOPE entry "${domain}": no catalog capability is in that domain (remove it)`,
      );
    }
  }
  for (const domain of UNMAPPED_DOMAINS) {
    if (!presentDomains.has(domain)) {
      errors.push(
        `stale UNMAPPED_DOMAINS entry "${domain}": no catalog capability is in that domain (remove it)`,
      );
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  truncatedSchemas.sort((a, b) => a.localeCompare(b));
  return { entries, errors, truncatedSchemas };
};

const printErrors = (errors: readonly string[]): void => {
  console.error(
    "\nexport-capability-catalog: cannot generate the catalog until these are resolved:",
  );
  for (const error of errors) {
    console.error(`  ${error}`);
  }
};

// Committed entries are untrusted JSON, so id lookup goes through a guard rather
// than assuming the CapabilityEntry shape.
const entryId = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry["id"] === "string" ? entry["id"] : undefined;

const byId = (entries: readonly unknown[]): Map<string, unknown> => {
  const map = new Map<string, unknown>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (id !== undefined) {
      map.set(id, entry);
    }
  }
  return map;
};

const summarizeDrift = (
  committed: readonly unknown[],
  generated: readonly CapabilityEntry[],
): void => {
  const committedById = byId(committed);
  const generatedById = byId(generated);

  const added = [...generatedById.keys()].filter(
    (id) => !committedById.has(id),
  );
  const removed = [...committedById.keys()].filter(
    (id) => !generatedById.has(id),
  );
  const changed = [...generatedById.keys()].filter((id) => {
    const committedEntry = committedById.get(id);
    if (committedEntry === undefined) {
      return false;
    }
    return (
      JSON.stringify(committedEntry) !== JSON.stringify(generatedById.get(id))
    );
  });

  console.error(
    "\nexport-capability-catalog: committed catalog is out of date. Regenerate with:",
  );
  console.error(
    "  bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts",
  );
  if (added.length > 0) {
    console.error(`\n  added (${added.length}): ${added.sort().join(", ")}`);
  }
  if (removed.length > 0) {
    console.error(
      `\n  removed (${removed.length}): ${removed.sort().join(", ")}`,
    );
  }
  if (changed.length > 0) {
    console.error(
      `\n  changed (${changed.length}): ${changed.sort().join(", ")}`,
    );
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.error(
      "\n  (only formatting/order differs — regenerate to normalize)",
    );
  }
};

const parseCommitted = async (): Promise<unknown[] | null> => {
  const file = Bun.file(CATALOG_PATH);
  if (!(await file.exists())) {
    return null;
  }
  // Malformed committed JSON is drift, not a crash: `null` routes the caller to
  // the "regenerate" message instead of letting `file.json()` throw.
  const parsed = await Result.tryPromise(
    async (): Promise<unknown> => await file.json(),
  );
  if (Result.isError(parsed)) {
    return null;
  }
  return Array.isArray(parsed.value) ? parsed.value : null;
};

const main = async (): Promise<number> => {
  const checkMode = process.argv.includes("--check");
  const { entries, errors, truncatedSchemas } = await buildCatalog();

  if (errors.length > 0) {
    printErrors(errors);
    return 1;
  }

  if (truncatedSchemas.length > 0) {
    process.stderr.write(
      `export-capability-catalog: ${truncatedSchemas.length} input schema(s) over the byte cap, omitted (inputSchemaTruncated): ${truncatedSchemas.join(", ")}\n`,
    );
  }

  const serialized = serializeCatalog(entries);

  if (!checkMode) {
    await Bun.write(CATALOG_PATH, serialized);
    process.stderr.write(
      `export-capability-catalog: wrote ${entries.length} capabilities to ${CATALOG_PATH}\n`,
    );
    return 0;
  }

  const committedText = await Bun.file(CATALOG_PATH)
    .text()
    .catch(() => null);
  if (committedText === serialized) {
    console.log(
      `export-capability-catalog: OK. ${entries.length} capabilities, catalog is up to date.`,
    );
    return 0;
  }

  const committed = await parseCommitted();
  if (committed === null) {
    console.error(
      "\nexport-capability-catalog: committed catalog is missing or malformed. Regenerate with:\n  bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts",
    );
    return 1;
  }
  summarizeDrift(committed, entries);
  return 1;
};

// The handler graph transitively opens a Redis subscriber (lib/sse.ts) at import
// time and never unrefs it, so this one-off script's event loop would hang. The
// work is done here; exit explicitly like export-mcp-tool-registry.ts.
process.exit(await main());
