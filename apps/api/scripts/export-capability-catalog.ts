// Dev-only exporter: projects the safe-handler universe down to a capability
// catalog and writes a deterministic JSON snapshot
// (`packages/cli/capability-catalog.json`).
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
// The snapshot is compact JSON (id-sorted entries, no indentation). Each
// entry's input schema goes through `$defs` compaction (repeated subschemas
// hoisted, occurrences replaced by same-document `$ref`s), then must fit
// MAX_CAPABILITY_SCHEMA_BYTES. Compaction is asserted lossless per capability:
// re-expanding the compacted schema must reproduce the source serialization
// byte for byte, or the export fails. An entry still over the cap after
// compaction also fails the export — no capability ships without a describable
// input shape.
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

import { KindGuard } from "@sinclair/typebox";
import { panic, Result } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Pure CLI generator modules (constants, classes, pure functions; no env, no
// I/O at import time), imported relatively because `@stll/cli`'s exports map
// only exposes its bin entry. The coverage doc computes each capability's REAL
// generated command path through the same `buildCliRouteTree` codegen uses, so
// collision fallbacks (curated command wins, capability relocates under
// `stella capability <domain> <action>`) are never hand-replicated here.
import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import { expandSchemaDefs } from "../../../packages/cli/src/expand-schema-defs";
import { buildCliRouteTree } from "../../../packages/cli/src/generate-capability-tree";
import type { RouteNode } from "../../../packages/cli/src/route-types";
import type { CapabilityTransport } from "../src/lib/capability-transport";
import {
  isTransportInvocable,
  transportFileResponse,
} from "../src/lib/capability-transport";
import { advertisedSchema } from "../src/mcp/advertised-schema";
import { CONTEXT_FIDELITY_WAIVERS } from "../src/mcp/capability-waivers";
import { PUBLIC_FIELD_NAME } from "../src/mcp/public-field-names";
import type { McpToolDefinition } from "../src/mcp/tool-types";
import {
  type CapabilityDispatchRecord,
  type AccessResolution,
  CANONICAL_ACTION_VERBS,
  CAPABILITY_ID_SEGMENT_PATTERN,
  type CapabilityInputSchema,
  checkTransportAgainstDerived,
  compareScopeStrictness,
  deriveActionVerb,
  deriveCapabilityId,
  deriveDomain,
  deriveHandlerImportPath,
  findInlineCapabilityMismatches,
  inputSchemaByteSize,
  isAllowedActionVerb,
  isDestructiveName,
  isWellFormedCapabilityId,
  MAX_CAPABILITY_SCHEMA_BYTES,
  parseCapabilityTransport,
  readScopeForDomainScope,
  resolveAccess,
  resolveHandlerKind,
  resolveScope,
  scanBinarySchemaFields,
  scanContextFidelity,
  scanFileResponseReturns,
  scanRouteHookGuards,
  serializeCatalog,
  serializeCoverageDoc,
  serializeDispatchModule,
  WRITE_ONLY_SCOPES,
} from "./lib/capability-catalog";
import {
  type CompactedCapabilityInputSchema,
  compactSchemaDefs,
} from "./lib/compact-schema-defs";
import {
  discoverSafeHandlers,
  type HandlerKind,
  isRecord,
  type ParsedExposure,
  REPO_ROOT,
} from "./lib/enumerate-safe-handlers";

const CATALOG_PATH = path.resolve(
  REPO_ROOT,
  "packages/cli/capability-catalog.json",
);

const DISPATCH_PATH = path.resolve(
  REPO_ROOT,
  "apps/api/src/mcp/generated/capability-dispatch.ts",
);

// Generated capability-coverage table: one section per domain plus the
// permanent internal-waiver summary, drift-guarded alongside the JSON/dispatch
// artifacts above (see `serializeCoverageDoc`).
const COVERAGE_DOC_PATH = path.resolve(
  REPO_ROOT,
  "docs/capability-coverage.md",
);

const OXFMT_BIN = path.resolve(REPO_ROOT, "node_modules/.bin/oxfmt");
const OXFMT_CONFIG = path.resolve(REPO_ROOT, ".oxfmtrc.json");

/**
 * Format a generated TS module with the repo's oxfmt config before it is
 * written or drift-compared, mirroring how the CLI codegen runs oxfmt over its
 * generated modules. Formatting through the real formatter (instead of hand-
 * matching its wrapping style) keeps the committed artifact byte-identical to
 * what CI's `oxfmt --check` expects, so the `--check` drift guard and the
 * format gate can never disagree. The temp file lives outside the repo so no
 * ignore rules apply to it.
 */
const formatGeneratedArtifact = async (
  raw: string,
  fileName: string,
): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capability-artifact-"));
  const tmpFile = path.join(dir, fileName);
  try {
    await Bun.write(tmpFile, raw);
    const proc = Bun.spawnSync([OXFMT_BIN, "-c", OXFMT_CONFIG, tmpFile], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if (proc.exitCode !== 0) {
      return panic(
        `export-capability-catalog: oxfmt failed on generated ${fileName}: ${proc.stderr.toString()}`,
      );
    }
    return await Bun.file(tmpFile).text();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

/**
 * MCP OAuth WRITE/consent scope per capability domain (the first id segment).
 * Each value is the scope a WRITE capability in that domain requires; a READ
 * capability resolves to the scope's read tier (`readScopeForDomainScope`), so
 * a read-only credential is never forced to hold a write grant. Writes reuse
 * their domain's write consent bucket; read-only domains map to the
 * read/admin-read scope their curated tools already use (read == write there).
 * A domain that appears in the catalog but is absent here (and from
 * UNMAPPED_DOMAINS) fails the export, so a new domain cannot ship without a
 * scope decision. Every value must be a real scope in
 * `apps/api/src/mcp/constants.ts`.
 */
const DOMAIN_SCOPE: Record<string, string> = {
  "audit-logs": "stella:admin_read",
  "billing-codes": "stella:billing_write",
  // Corpus reads (decision analysis, ingestion status, matter-link list)
  // alongside matter-link create/delete, which link a global decision into a
  // workspace matter; the domain contains workspace-scoped writes, so it reuses
  // the workspace write bucket rather than the read scope legislation uses.
  "case-law": "stella:matters_write",
  catalogue: "stella:skills",
  // Chat-thread capabilities (list/read threads and messages, rename, update,
  // delete) are workspace-scoped assistant content that should not demand a
  // matters-write consent. They get their own dedicated consent bucket rather
  // than borrowing the workspace write scope.
  chat: "stella:chat",
  clauses: "stella:knowledge_write",
  // Organization-wide address-book mutations cross matter boundaries, so
  // they require their own consent instead of borrowing a workspace write.
  contacts: "stella:contacts_write",
  "document-types": "stella:matters_write",
  // A translation run reads a matter document and writes the translated one
  // back as a new document, so it takes the workspace write bucket.
  "document-translations": "stella:matters_write",
  entities: "stella:matters_write",
  expenses: "stella:billing_write",
  fields: "stella:matters_write",
  // Workflow (flow) definition CRUD plus run start/cancel/review: org-scoped
  // automations that read and write workspace matter content, so they reuse the
  // workspace write bucket rather than a dedicated read scope.
  flows: "stella:matters_write",
  signals: "stella:matters_write",
  // Now carries invoice create/delete/transition capabilities, not just the
  // read tool, so it reuses the billing write bucket.
  invoices: "stella:billing_write",
  legislation: "stella:read",
  lists: "stella:matters_write",
  "organization-settings": "stella:admin_write",
  playbooks: "stella:knowledge_write",
  // Now carries property create/update/delete capabilities, so it reuses the
  // workspace write bucket rather than the read scope its read tool used.
  properties: "stella:matters_write",
  // Now carries rate-card create/update/delete capabilities, so it reuses the
  // billing write bucket rather than the read scope its resolution tool used.
  rates: "stella:billing_write",
  // Report export creates workspace artifacts (entities / template records), so
  // it stays on the workspace write bucket. Unlike chat (which got its own
  // stella:chat scope because thread reads/renames should not demand a
  // matters-write consent), a report export is a genuine workspace write, so a
  // dedicated read-only scope would understate what it does.
  reports: "stella:matters_write",
  skills: "stella:skills",
  "style-sets": "stella:templates",
  tasks: "stella:matters_write",
  "template-packs": "stella:templates",
  "template-recipes": "stella:templates",
  templates: "stella:templates",
  "time-entries": "stella:billing_write",
  // Presigned-upload coordination (presign / finalize / abort). One domain,
  // three upload purposes with different underlying permissions
  // (entity:create, entity:update, agentSkill:create), so the domain takes the
  // workspace write bucket and `authorizeUploadPurpose` re-checks the exact
  // per-purpose permission inside the handler. Deliberately NOT
  // `stella:skills`, which would let a skills-only consent presign an entity
  // write. The converse is closed at invoke: the purpose an upload carries adds
  // its own required scope and permission (`mcp/upload-purpose-gate.ts`), so a
  // workspace write consent alone cannot presign or finalize a skill pack.
  uploads: "stella:matters_write",
  usage: "stella:read",
  "view-templates": "stella:matters_write",
  views: "stella:matters_write",
  "work-obligations": "stella:matters_write",
  matters: "stella:matters_write",
};

/**
 * Domains deliberately acknowledged as having no fitting existing scope. Empty:
 * every catalog domain maps to an existing scope. An entry here is reported by
 * the export (so the gap is visible) and its handlers are omitted from the
 * catalog rather than assigned an invented scope.
 */
const UNMAPPED_DOMAINS: ReadonlySet<string> = new Set<string>();

/**
 * Strictness tiers for the covered-tool scope check (see
 * `compareScopeStrictness`). Scopes are independent OAuth grants, so this
 * ordering is a reviewed export-time decision, not a server-side hierarchy:
 * search < read < the per-domain write/admin-read consents < admin_write.
 * Distinct scopes sharing a tier (e.g. matters_write vs documents_write) are
 * incomparable: an entry whose covering tool sits at the same tier under a
 * different scope fails the export until pinned in ENTRY_SCOPE_OVERRIDES.
 */
const SCOPE_STRICTNESS: Record<string, number> = {
  "stella:search": 0,
  "stella:read": 1,
  "stella:onboarding": 2,
  "stella:templates": 2,
  "stella:contacts_write": 2,
  "stella:documents_write": 2,
  "stella:matters_write": 2,
  "stella:chat": 2,
  "stella:knowledge_write": 2,
  "stella:billing_write": 2,
  "stella:skills": 2,
  "stella:external_mcps": 2,
  "stella:feedback": 2,
  "stella:admin_read": 2,
  "stella:admin_write": 3,
};

/**
 * Per-entry scope pins. `tool`/`covered` pins resolve entries whose covering
 * tool's scope is incomparable with their domain scope (same strictness tier,
 * different consent family); capability pins cover exceptional endpoints that
 * belong to a stricter consent family than the rest of their route domain.
 * Tool-backed pins are still checked against the covering tool, so a pin cannot
 * under-claim. Most current entries back `save_document` / `delete_document` /
 * `set_field_value`.
 * (stella:documents_write) from domains mapped to stella:matters_write: the
 * capability is the same operation as the tool, so the generic path demands
 * the same consent.
 */
const ENTRY_SCOPE_OVERRIDES: Record<string, string> = {
  "entities.create": "stella:documents_write",
  "entities.create-blank-document": "stella:documents_write",
  "entities.delete": "stella:documents_write",
  "entities.delete-version": "stella:documents_write",
  "entities.move": "stella:documents_write",
  "entities.rename": "stella:documents_write",
  "entities.update-version-description": "stella:documents_write",
  "entities.update-version-label": "stella:documents_write",
  "fields.upsert-by-id": "stella:documents_write",
  // Filling is template-domain work, but this endpoint persists a new matter
  // entity and is covered by save_filled_template. Generic invocation must
  // therefore require the same document-write consent as the named tool.
  "templates.fill-to-matter": "stella:documents_write",
};

/**
 * Handler-scope kind for capabilities whose file mixes safe-handler factories,
 * so the export cannot attribute the kind from the file's single factory. Empty:
 * no handler file currently mixes factory kinds. A file that starts mixing them
 * fails the export until the ambiguous export is pinned here.
 */
const HANDLER_KIND_OVERRIDES: Record<string, HandlerKind> = {};

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
const INLINE_CAPABILITY_ALLOWLIST: Record<string, number> = {};

/**
 * Capabilities whose REST route resolves workspace access through
 * `validateWorkspaceAccessIncludingArchived` (so they may run against an
 * archived workspace), carried into the catalog as `allowsArchivedWorkspace` and
 * consulted by the invoke write gate (see capability-tools.ts). Sweep of
 * `validateWorkspaceAccessIncludingArchived` usages over capability endpoints
 * (apps/api/src/handlers/workspaces/routes.ts): only `unarchive`. Stale-checked:
 * a flagged id that is no longer a discovered capability fails the export.
 *
 * - `matters.unarchive`: flips an archived workspace back to active; must be
 *   reachable while the workspace is archived.
 */
const ALLOWS_ARCHIVED_WORKSPACE: ReadonlySet<string> = new Set([
  "matters.unarchive",
]);

/**
 * Waivers for capability endpoints mounted under a route-level
 * `onBeforeHandle`/`beforeHandle` hook the generic invoke path would bypass
 * (see `scanRouteHookGuards`). Each entry is a reviewed decision that the hook's
 * gate is also enforced in the handler config (id -> justification), or the
 * export fails on the hit. Empty: the one prior hit (`case-law.ingestion.status`)
 * moved its admin/owner gate into the handler config (`auditLog: ["read"]`), so
 * no capability endpoint sits under a route hook.
 */
const ROUTE_HOOK_WAIVERS: Record<string, string> = {};

/**
 * Deployment feature flag per capability domain, mirroring the `feature` field
 * on static tools so the generic invoke path honors the same deployment gates
 * as the advertised tool list (list_capabilities hides, describe/invoke refuse
 * with `feature_disabled`). An entry's flag resolves as: the covering tool's
 * `feature` (mechanical, for tool/covered dispositions) else this table.
 *
 * Seeded from the sweep of feature-tagged static tools and server-enforced
 * route gates:
 *  - FEATURE_TIME_BILLING gates the billing tool family (list/save/delete
 *    time entries, resolve_rate, list_invoices) and the billing app routes;
 *    the whole billing capability surface (time-entries, rates, invoices,
 *    expenses, billing-codes) rides the same flag.
 *  - FEATURE_PUBLIC_LAW gates the public legal-corpus surface (search_case_law,
 *    read_case_law_decision, search_legislation, and the public case-law
 *    routes); legislation and case-law capabilities (corpus analysis,
 *    matter-links into corpus decisions, ingestion admin) are corpus-backed.
 *  - FEATURE_USAGE gates only `get_usage` (tool disposition; inherited
 *    mechanically, no capability-disposition entries), so `usage` needs no row.
 * Web-only flags (FEATURE_CHAT, FEATURE_CONTACTS, FEATURE_TODOS, ...) gate UI
 * routes, not any API surface (their REST routes mount unconditionally), so
 * they are deliberately NOT applied here: invoke stays exactly as gated as the
 * REST + static-tool surface, no stricter.
 *
 * Guards: every value must be a FEATURE_* key of the API env (checked at
 * export time against the real env object); a stale domain (no catalog
 * entries) fails the export; a domain whose
 * covering tools carry a feature but that is absent here (or that names a
 * different feature than an entry inherits) fails the export, so a new gated
 * tool family cannot leave its sibling capabilities un-gated.
 */
const DOMAIN_FEATURE: Record<string, string> = {
  "billing-codes": "FEATURE_TIME_BILLING",
  "case-law": "FEATURE_PUBLIC_LAW",
  expenses: "FEATURE_TIME_BILLING",
  invoices: "FEATURE_TIME_BILLING",
  legislation: "FEATURE_PUBLIC_LAW",
  lists: "FEATURE_LEGAL_LISTS",
  rates: "FEATURE_TIME_BILLING",
  "template-packs": "FEATURE_TEMPLATE_PACKS",
  "time-entries": "FEATURE_TIME_BILLING",
  "work-obligations": "FEATURE_GOVERNED_WORKFLOW",
};

type CapabilityMcp =
  | { type: "tool"; name: string }
  | { type: "covered"; by: string }
  | { type: "capability"; reason: string };

type CapabilityEntry = {
  id: string;
  /**
   * Prose from the handler config's `description`, written for the agent
   * deciding whether to call this capability. Carried verbatim into the
   * committed catalog; the CLI renders it as the generated command's
   * `--help` brief and MCP renders it in list/describe. Absent only for a
   * capability that has not been given one yet; each of those is listed by id
   * in apps/api/capability-description-ledger.json and guarded by
   * apps/api/scripts/capability-description-guard.ts.
   */
  description?: string;
  handlerKind: HandlerKind;
  access: "read" | "write";
  destructive: boolean;
  scope: string;
  /** Additional OAuth grants required by a compound covering tool. */
  additionalScopes?: readonly string[];
  /** REST route uses `validateWorkspaceAccessIncludingArchived` (fix-4). */
  allowsArchivedWorkspace?: true;
  /**
   * How this capability's payload crosses the generic JSON transport. Total and
   * always present: every entry states `{ type: "json" }` or names the concrete
   * file leg(s), the field carrying the bytes, whether that field is optional
   * (a fileless mode), and the alternative transport. The handler declares it;
   * the exporter cross-checks both legs against the live schema and the handler
   * source, so it can be neither absent nor stale.
   */
  transport: CapabilityTransport;
  /**
   * Deployment feature flag gating this capability: the covering tool's
   * `feature` (tool/covered dispositions) else the DOMAIN_FEATURE table.
   * Consulted by list_capabilities/describe/invoke (see capability-feature.ts).
   */
  feature?: string;
  permissions?: unknown;
  /**
   * The handler config's `body`/`params`/`query`, `$defs`-compacted: repeated
   * subschemas are hoisted into `$defs` and their occurrences replaced by
   * `#/$defs/...` refs. Consumers expand it with `expandSchemaDefs`, which
   * reproduces the config's schema exactly. Always present: an entry whose
   * schema cannot be compacted under MAX_CAPABILITY_SCHEMA_BYTES fails the
   * export.
   */
  inputSchema: CompactedCapabilityInputSchema;
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
    inputSchema.body = withPublicFieldNames(advertisedPart(config["body"]));
  }
  if ("params" in config) {
    inputSchema.params = withPublicFieldNames(advertisedPart(config["params"]));
  }
  if ("query" in config) {
    inputSchema.query = withPublicFieldNames(advertisedPart(config["query"]));
  }
  return inputSchema;
};

/**
 * The catalog carries the same projection `describe_capability` advertises
 * (coercion unions flattened to their scalar), so the CLI's generated flags
 * and the MCP surface enforce one contract. A part that is not a TypeBox
 * schema is left as the handler declared it.
 */
const advertisedPart = (part: unknown): unknown =>
  KindGuard.IsSchema(part) ? advertisedSchema(part) : part;

/** Schema keywords whose value is itself a schema node. */
const SCHEMA_NODE_KEYWORDS = ["items", "additionalProperties", "not"] as const;
/** Schema keywords whose value is a list of schema nodes. */
const SCHEMA_NODE_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;
/** Schema keywords whose value maps names to schema nodes. */
const SCHEMA_NODE_MAP_KEYWORDS = [
  "properties",
  "$defs",
  "definitions",
] as const;

/**
 * Rename internal input fields to their public spelling on the way out, at
 * every depth.
 *
 * The container is a `workspaceId` in the DB, the handler config and the REST
 * route; it is a `matterId` to every agent. This is the outbound half of that
 * split: `describe_capability` and the CLI's generated `--matter-id` flag both
 * read this schema. The inbound half is `withInternalFieldNames`
 * (apps/api/src/mcp/capability-tools.ts), which renames the field back before
 * the handler's own schema validates it, so the two names never both reach a
 * handler. Both halves derive from `PUBLIC_FIELD_NAME`'s one table.
 *
 * The walk covers every place a schema node can hide (`properties`, `items`,
 * `additionalProperties`, `anyOf`/`oneOf`/`allOf`, `$defs`), because the
 * container is not always top level: `flows.create` carries it inside a union
 * branch of `body.trigger`, `playbooks.create` inside an array of passages,
 * `signals.acceptances.create` inside `body.result`. Renaming only the top
 * level would advertise `--matter-id` on one capability and
 * `--body-trigger-workspace-id` on the next.
 *
 * The exemption is evaluated per NODE, not per part: a node that already owns
 * the public name (`expenses.create` body declares its own `matterId`) has no
 * internal name to rename, so the two cannot meet.
 */
const withPublicFieldNames = (node: unknown): unknown => {
  if (Array.isArray(node)) {
    return node.map((entry) => withPublicFieldNames(entry));
  }
  if (!isRecord(node)) {
    return node;
  }
  const rename = (name: string): string => PUBLIC_FIELD_NAME[name] ?? name;
  const projected: Record<string, unknown> = { ...node };

  for (const keyword of SCHEMA_NODE_KEYWORDS) {
    if (keyword in node) {
      projected[keyword] = withPublicFieldNames(node[keyword]);
    }
  }
  for (const keyword of SCHEMA_NODE_LIST_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      projected[keyword] = branches.map((branch) =>
        withPublicFieldNames(branch),
      );
    }
  }
  for (const keyword of SCHEMA_NODE_MAP_KEYWORDS) {
    const members = node[keyword];
    if (!isRecord(members)) {
      continue;
    }
    // `$defs`/`definitions` name reusable schemas, not input fields, so only
    // `properties` keys are renamed; every value is still descended into.
    const renameKeys = keyword === "properties";
    if (renameKeys) {
      for (const [internal, publicName] of Object.entries(PUBLIC_FIELD_NAME)) {
        if (internal in members && publicName in members) {
          panic(
            `capability input declares both ${internal} and ${publicName}; the public rename would drop one`,
          );
        }
      }
    }
    projected[keyword] = Object.fromEntries(
      Object.entries(members).map(([name, member]) => [
        renameKeys ? rename(name) : name,
        withPublicFieldNames(member),
      ]),
    );
  }

  const required = node["required"];
  if (Array.isArray(required)) {
    projected["required"] = required.map((name) =>
      typeof name === "string" ? rename(name) : name,
    );
  }
  return projected;
};

/**
 * The handler config's tool-level `description`. A non-string or empty value is
 * reported as absent rather than emitted, so a malformed config shows up as a
 * gap in the description ledger instead of putting junk prose in front
 * of an agent.
 */
const readDescription = (
  config: Record<string, unknown>,
): string | undefined => {
  const description = config["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    return undefined;
  }
  return description;
};

type EntryScopeResult =
  | { status: "resolved"; scope: string }
  | { status: "error"; message: string };

/**
 * Final scope for a `tool`/`covered` entry: the entry must never advertise a
 * weaker consent than the curated tool that backs it, or the generic capability
 * path would gate the same operation behind less consent than the tool. The
 * entry's access-resolved base scope (its read-tier scope for a read capability,
 * its write/consent scope for a write) is kept when it is at least as strict as
 * the covering tool's scope, the tool's scope is inherited when stricter, and an
 * incomparable/unknown pairing fails the export.
 */
const resolveEntryScopeAgainstTool = ({
  id,
  base,
  toolName,
  toolScope,
}: {
  id: string;
  base: string;
  toolName: string;
  toolScope: string | undefined;
}): EntryScopeResult => {
  if (toolScope === undefined) {
    return {
      status: "error",
      message: `capability "${id}" names covering tool "${toolName}", which is not in the static registry`,
    };
  }
  const comparison = compareScopeStrictness({
    first: base,
    second: toolScope,
    tiers: SCOPE_STRICTNESS,
  });
  if (comparison === "equal" || comparison === "first-stricter") {
    return { status: "resolved", scope: base };
  }
  if (comparison === "second-stricter") {
    return { status: "resolved", scope: toolScope };
  }
  return {
    status: "error",
    message: `capability "${id}" would advertise scope "${base}" weaker than (or ${comparison} with) covering tool "${toolName}"'s scope "${toolScope}"; pin the entry in ENTRY_SCOPE_OVERRIDES or extend SCOPE_STRICTNESS`,
  };
};

type BuildResult = {
  entries: CapabilityEntry[];
  dispatchRecords: CapabilityDispatchRecord[];
  errors: string[];
  /**
   * Tally of `internal`-disposition endpoints by their `reason`: permanent
   * reviewed waivers (auth/token plumbing, transport mechanics, ...) that never
   * enter the catalog. Fed to `serializeCoverageDoc` for the doc's "Waived
   * internal handlers" summary.
   */
  internalWaiverCounts: Record<string, number>;
};

/** Covering-tool name for a tool/covered exposure; undefined otherwise. */
const coveringToolOf = (exposure: ParsedExposure): string | undefined => {
  if (exposure.type === "tool") {
    return exposure.name;
  }
  if (exposure.type === "covered") {
    return exposure.by;
  }
  return undefined;
};

type BuildCatalogEntryOptions = {
  id: string;
  /** Handler config's `description`, absent when the handler declares none. */
  description: string | undefined;
  kind: HandlerKind;
  access: { access: "read" | "write"; destructive: boolean };
  scope: string;
  additionalScopes: readonly string[];
  hasPermissions: boolean;
  permissions: unknown;
  /**
   * The `$defs`-compacted input schema: what the entry carries. The live
   * pre-compaction shape is read at the call site, where the transport is
   * derived and cross-checked against it.
   */
  compactedInputSchema: CompactedCapabilityInputSchema;
  exposure: ParsedExposure;
  feature: string | undefined;
  /** Declared transport, already cross-checked against the live schema. */
  transport: CapabilityTransport;
};

/**
 * Assemble one catalog entry from its resolved pieces. `transport` is emitted on
 * every entry (the field is total, so a consumer never has to read an absence as
 * a decision), and it is derived from the LIVE schema, which is the same shape
 * the compacted one expands to. The remaining optional flags stay
 * omitted-when-false so the compact snapshot does not grow a column of `false`s.
 */
const buildCatalogEntry = ({
  id,
  description,
  kind,
  access,
  scope,
  additionalScopes,
  hasPermissions,
  permissions,
  compactedInputSchema,
  exposure,
  feature,
  transport,
}: BuildCatalogEntryOptions): CapabilityEntry => ({
  id,
  ...(description === undefined ? {} : { description }),
  handlerKind: kind,
  access: access.access,
  destructive: access.destructive,
  scope,
  ...(additionalScopes.length === 0 ? {} : { additionalScopes }),
  ...(ALLOWS_ARCHIVED_WORKSPACE.has(id)
    ? { allowsArchivedWorkspace: true as const }
    : {}),
  transport,
  ...(feature === undefined ? {} : { feature }),
  ...(hasPermissions ? { permissions } : {}),
  inputSchema: compactedInputSchema,
  mcp: toCapabilityMcp(exposure),
});

/**
 * `$defs`-compact one capability's input schema, with the two invariants that
 * make the compacted artifact trustworthy checked on the spot:
 *
 *  1. LOSSLESS: re-expanding the compacted schema must reproduce the source
 *     serialization byte for byte. This is the gate that stops a compacted
 *     schema from ever describing a different input set than the handler
 *     validates — a widened schema would accept input the handler rejects, a
 *     narrowed one would make the CLI reject input the handler accepts.
 *  2. UNDER THE CAP: compaction is what brought the recursive view/condition
 *     schemas under MAX_CAPABILITY_SCHEMA_BYTES. An entry still over it fails
 *     the export instead of shipping as an opaque, flagless capability.
 *
 * Both failures are pushed onto `errors`, so the export reports every offender
 * at once and writes nothing. The uncompacted schema is returned in that case
 * purely so the remaining guards can keep running over a well-typed entry.
 */
const compactInputSchemaGuarded = ({
  errors,
  id,
  inputSchema,
}: {
  errors: string[];
  id: string;
  inputSchema: CapabilityInputSchema;
}): CompactedCapabilityInputSchema => {
  const compaction = compactSchemaDefs(inputSchema);
  if (compaction.status === "unsupported") {
    errors.push(
      `capability "${id}": input schema cannot be $defs-compacted: ${compaction.reason}`,
    );
    return inputSchema;
  }
  const compacted = compaction.inputSchema;
  const expanded = expandSchemaDefs(compacted);
  if (
    expanded === null ||
    JSON.stringify(expanded) !== JSON.stringify(inputSchema)
  ) {
    errors.push(
      `capability "${id}": expanding the $defs-compacted input schema did not reproduce the source schema. The compacted snapshot would describe a different input set than the handler validates; fix compact-schema-defs.ts / expand-schema-defs.ts, never ship the mismatch`,
    );
    return inputSchema;
  }
  const bytes = inputSchemaByteSize(compacted);
  if (bytes > MAX_CAPABILITY_SCHEMA_BYTES) {
    errors.push(
      `capability "${id}": input schema is ${bytes} bytes after $defs compaction, over the ${MAX_CAPABILITY_SCHEMA_BYTES}-byte cap. Shrink the handler's schema (factor the repeated shape into one reusable TypeBox type) or improve compaction; the cap is not the thing to raise`,
    );
    return compacted;
  }
  return compacted;
};

/**
 * Class guards over the built catalog entries. Each returns reviewer-actionable
 * messages (empty when clean) that fail the export:
 *  - context-fidelity: a handler reaching for un-honorable request/response
 *    context must be waived;
 *  - file-response (fix-6): a handler returning a file/stream Response must be
 *    flagged (refused at invoke);
 *  - route-hook (fix-2): a capability endpoint under a route-level pre-handler
 *    hook the generic path bypasses must be waived (gate also in the handler);
 *  - archived-flag (fix-4) stale check: a flagged id must still be a capability.
 */
const collectClassGuardErrors = ({
  entries,
  entrySources,
  routeFiles,
  toolFeatureByName,
}: {
  entries: readonly CapabilityEntry[];
  entrySources: readonly { id: string; source: string }[];
  routeFiles: readonly { id: string; source: string }[];
  toolFeatureByName: ReadonlyMap<string, string>;
}): string[] => {
  const errors: string[] = [];
  const capabilityIdSet = new Set(entries.map((entry) => entry.id));

  // Read-scope guard: a READ capability must never require a write-only scope,
  // or a read-only credential (`stella:read` / `stella:admin_read`) could not
  // invoke it. The access-keyed resolver above already downgrades reads to their
  // domain read tier, so this can only fire if that resolver is later broken —
  // which is exactly when it must fail the export (companion to the
  // `read-capabilities-with-write-scope` ratchet over the committed catalog).
  for (const entry of entries) {
    if (entry.access === "read" && WRITE_ONLY_SCOPES.has(entry.scope)) {
      errors.push(
        `read capability "${entry.id}" resolves to write-only scope "${entry.scope}"; a read-only credential could never invoke it. A read must resolve to its domain read scope (see readScopeForDomainScope): fix DOMAIN_SCOPE / the access-keyed scope resolver, do not pin a write scope onto a read`,
      );
    }
  }

  const fidelity = scanContextFidelity({
    entries: entrySources,
    waivedIds: new Set(CONTEXT_FIDELITY_WAIVERS.keys()),
  });
  for (const { id, features } of fidelity.violations) {
    errors.push(
      `context-fidelity: capability "${id}" uses un-honorable context feature(s) [${features.join(", ")}] the generic invoke path cannot honor. Refactor the handler to return a plain payload, or add "${id}" to CONTEXT_FIDELITY_WAIVERS with a justification (it will then be refused at invoke)`,
    );
  }
  for (const id of fidelity.staleWaivers) {
    errors.push(
      `stale CONTEXT_FIDELITY_WAIVERS entry "${id}": its handler no longer uses an un-honorable context feature (remove it)`,
    );
  }

  const fileResponses = scanFileResponseReturns({
    entries: entrySources,
    flaggedIds: new Set(
      entries
        .filter((entry) => transportFileResponse(entry.transport) !== undefined)
        .map((entry) => entry.id),
    ),
  });
  for (const id of fileResponses.violations) {
    errors.push(
      `file-response: capability "${id}" returns a web Response or raw binary payload on success, which the generic invoke path cannot serialize. Declare a file-response (or file-both) transport on its handler config, naming the media types it produces and the alternative transport, or refactor the handler to return a structured payload`,
    );
  }
  for (const id of fileResponses.staleFlags) {
    errors.push(
      `stale file-response transport on "${id}": its handler no longer constructs a file-like value, so the response leg of its transport declaration is a lie (remove it)`,
    );
  }

  const routeHooks = scanRouteHookGuards({
    routeFiles,
    capabilityIds: capabilityIdSet,
    waivedIds: new Set(Object.keys(ROUTE_HOOK_WAIVERS)),
  });
  for (const { routeFile, id } of routeHooks.violations) {
    errors.push(
      `route-hook: capability "${id}" is mounted under a route-level onBeforeHandle/beforeHandle hook in ${routeFile} that invoke_capability bypasses. Move the gate into the handler config (like case-law.ingestion.status), or add "${id}" to ROUTE_HOOK_WAIVERS with a justification`,
    );
  }
  for (const id of routeHooks.staleWaivers) {
    errors.push(
      `stale ROUTE_HOOK_WAIVERS entry "${id}": it is no longer mounted under any route hook (remove it)`,
    );
  }

  for (const id of ALLOWS_ARCHIVED_WORKSPACE) {
    if (!capabilityIdSet.has(id)) {
      errors.push(
        `stale ALLOWS_ARCHIVED_WORKSPACE entry "${id}": no catalog capability has that id (remove it)`,
      );
    }
  }

  // Feature-gate coherence: DOMAIN_FEATURE must stay in lockstep with the
  // covering tools' feature tags so a gated tool family can never leave its
  // sibling capability-disposition entries un-gated (or gated differently).
  const presentDomains = new Set(
    entries.map((entry) => deriveDomain(entry.id)),
  );
  for (const domain of Object.keys(DOMAIN_FEATURE)) {
    if (!presentDomains.has(domain)) {
      errors.push(
        `stale DOMAIN_FEATURE entry "${domain}": no catalog capability is in that domain (remove it)`,
      );
    }
  }
  const inheritedByDomain = new Map<string, Set<string>>();
  const capabilityDispositionDomains = new Set<string>();
  for (const entry of entries) {
    const domain = deriveDomain(entry.id);
    if (entry.mcp.type === "capability") {
      capabilityDispositionDomains.add(domain);
      continue;
    }
    const covering = entry.mcp.type === "tool" ? entry.mcp.name : entry.mcp.by;
    const inherited = toolFeatureByName.get(covering);
    if (inherited !== undefined) {
      const set = inheritedByDomain.get(domain) ?? new Set();
      set.add(inherited);
      inheritedByDomain.set(domain, set);
    }
  }
  for (const [domain, inherited] of inheritedByDomain) {
    const tableFeature = DOMAIN_FEATURE[domain];
    for (const feature of inherited) {
      if (tableFeature !== undefined && tableFeature !== feature) {
        errors.push(
          `DOMAIN_FEATURE["${domain}"] = "${tableFeature}" conflicts with covering-tool feature "${feature}" inherited by the domain's tool/covered entries; align them`,
        );
      }
    }
    if (
      tableFeature === undefined &&
      capabilityDispositionDomains.has(domain)
    ) {
      errors.push(
        `domain "${domain}" inherits covering-tool feature(s) [${[...inherited].join(", ")}] but has capability-disposition entries and no DOMAIN_FEATURE row; add one so the whole domain is gated consistently`,
      );
    }
  }
  return errors;
};

const buildCatalog = async (): Promise<BuildResult> => {
  const { endpoints, files, importErrors } = await discoverSafeHandlers();
  const errors: string[] = [];

  for (const { id, message } of importErrors) {
    errors.push(`import failed: ${id}: ${message}`);
  }

  // Covering-tool scopes for the under-claim check. Imported dynamically after
  // discovery so `setup-env` has already seeded the API env defaults the module
  // graph validates at load (same ordering as the coverage guard).
  const { DEFAULT_MCP_TOOL_DEFINITIONS: narrowToolDefinitions } =
    await import("../src/mcp/static-tool-definitions");
  const toolDefinitions: readonly McpToolDefinition[] = narrowToolDefinitions;
  const toolScopeByName = new Map<string, string>(
    toolDefinitions.map((tool) => [tool.name, tool.scope]),
  );
  const toolAdditionalScopesByName = new Map<string, readonly string[]>(
    toolDefinitions.map((tool) => [tool.name, tool.additionalScopes ?? []]),
  );
  // Covering-tool feature flags: a tool/covered entry inherits its covering
  // tool's deployment gate mechanically (see DOMAIN_FEATURE for the rest).
  const toolFeatureByName = new Map<string, string>(
    narrowToolDefinitions.flatMap((tool) => {
      const feature = Reflect.get(tool, "feature");
      return typeof feature === "string" ? [[tool.name, feature] as const] : [];
    }),
  );
  // DOMAIN_FEATURE values are plain strings (the McpToolFeatureFlag key-of-env
  // type collapses outside the app tsconfig), so validate every flag against
  // the REAL deployment env at export time: a typo'd or removed flag fails the
  // build here instead of silently fail-closing every entry at runtime.
  const { env } = await import("../src/env");
  for (const [domain, flag] of Object.entries(DOMAIN_FEATURE)) {
    if (!flag.startsWith("FEATURE_") || !Object.hasOwn(env, flag)) {
      errors.push(
        `DOMAIN_FEATURE["${domain}"] names "${flag}", which is not a FEATURE_* key of the API env; fix the flag name`,
      );
    }
  }

  const kindsByFile = new Map(files.map((file) => [file.id, file.kinds]));
  const sourceByFile = new Map(files.map((file) => [file.id, file.source]));
  const entries: CapabilityEntry[] = [];
  const dispatchRecords: CapabilityDispatchRecord[] = [];
  const entrySources: { id: string; source: string }[] = [];
  const idToFile = new Map<string, string>();
  const presentDomains = new Set<string>();
  const kindOverrideUses: string[] = [];
  const optOutUses = new Set<string>();
  const scopeOverrideUses = new Set<string>();

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
  // Permanent `internal` waivers, tallied by reason for the coverage doc's
  // summary section. These endpoints never enter `entries` (the main loop
  // below only admits tool/covered/capability dispositions).
  const internalWaiverCounts: Record<string, number> = {};
  for (const endpoint of endpoints) {
    if (endpoint.exposure.type !== "internal") {
      continue;
    }
    const { reason } = endpoint.exposure;
    internalWaiverCounts[reason] = (internalWaiverCounts[reason] ?? 0) + 1;
  }

  const discoveredFiles = new Set(files.map(({ id }) => id));
  for (const id of Object.keys(INLINE_CAPABILITY_ALLOWLIST)) {
    if (!discoveredFiles.has(id)) {
      errors.push(
        `stale INLINE_CAPABILITY_ALLOWLIST entry "${id}": file no longer discovered (remove it so it cannot admit future inline capabilities)`,
      );
    }
  }

  /** Compile one discovered handler into its catalog and dispatch projections. */
  const projectEndpoint = (endpoint: (typeof endpoints)[number]): void => {
    if (
      endpoint.exposure.type !== "tool" &&
      endpoint.exposure.type !== "covered" &&
      endpoint.exposure.type !== "capability"
    ) {
      return;
    }
    const id = deriveCapabilityId({
      file: endpoint.file,
      exportName: endpoint.exportName,
    });
    if (!isWellFormedCapabilityId(id)) {
      // Capability ids are public (CLI command paths, `invoke_capability`
      // arguments), so an id segment must never be an internal identifier. The
      // only way to produce a non-kebab segment is a NAMED export, whose TS
      // identifier gets suffixed onto the path-derived id.
      errors.push(
        `malformed capability id "${id}" from ${endpoint.file}: every \`.\`-separated segment must be lowercase kebab-case (${CAPABILITY_ID_SEGMENT_PATTERN.source}). Capability ids are public, so give this endpoint its own kebab-case-named file and export it as the file's DEFAULT export instead of a named one`,
      );
      return;
    }
    if (!isAllowedActionVerb(id)) {
      // The final id segment is the PUBLIC action verb (`stella contacts list`,
      // `invoke_capability contacts.list`). Keeping it inside a small canonical
      // set plus a reviewed domain list is what stops the surface drifting back
      // into synonym soup (`read` vs `list` vs `get` for the same shape).
      errors.push(
        `non-conforming action verb "${deriveActionVerb(id)}" in capability id "${id}" from ${endpoint.file}: the final id segment must be one of ${[...CANONICAL_ACTION_VERBS].sort().join(", ")}, or an explicitly reviewed entry in DOMAIN_ACTION_VERBS. Prefer renaming the handler file to a canonical verb, or splitting a compound verb into a nested resource directory (\`clauses/categories/create.ts\` over \`clauses/categories-create.ts\`)`,
      );
      return;
    }
    const existing = idToFile.get(id);
    if (existing !== undefined) {
      errors.push(
        `duplicate capability id "${id}" from ${existing} and ${endpoint.file}`,
      );
      return;
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
    // `access` is DECLARED on the config, not inferred: a handler's permission
    // gate answers "who may call this", a different axis from whether it reads
    // or writes (the same `workspace:["read"]` gate fronts a pure list and a
    // cache-filling write). When declared it is authoritative; inference only
    // proposes, and the affirmation guard below refuses to ship an unaffirmed
    // read (which would resolve to a `stella:read`-reachable scope).
    const declaredAccessValue = endpoint.config["access"];
    const declaredAccess =
      declaredAccessValue === "read" || declaredAccessValue === "write"
        ? declaredAccessValue
        : undefined;
    if (declaredAccessValue !== undefined && declaredAccess === undefined) {
      errors.push(
        `capability "${id}" declares invalid access ${JSON.stringify(declaredAccessValue)}; expected "read" or "write"`,
      );
    }
    const inferredAccess = resolveAccess({
      id,
      verbs,
      hasPermissions,
      overrides: {},
      destructiveNameOptOuts: DESTRUCTIVE_NAME_OPT_OUTS,
    });
    const accessResolution: AccessResolution =
      declaredAccess === undefined
        ? inferredAccess
        : {
            status: "resolved",
            access: declaredAccess,
            destructive:
              !DESTRUCTIVE_NAME_OPT_OUTS.has(id) && isDestructiveName(id),
          };
    // Affirmation guard: a read resolves to a `stella:read`-reachable scope, so
    // it must be an explicit, reviewed decision — never an inference. An
    // inferred read (no `access` on the config) fails the export until someone
    // affirms it read or corrects it to write.
    if (
      accessResolution.status === "resolved" &&
      accessResolution.access === "read" &&
      declaredAccess !== "read"
    ) {
      errors.push(
        `capability "${id}" resolves to a read scope by inference, not affirmation. A read scope is reachable with stella:read consent, so it must be a reviewed decision: declare access: "read" on the handler config if it is a pure read, or access: "write" if it mutates (a DB write, an AI generation, a job enqueue).`,
      );
    }

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
      return;
    }

    const override = ENTRY_SCOPE_OVERRIDES[id];
    if (override !== undefined && !Object.hasOwn(SCOPE_STRICTNESS, override)) {
      errors.push(
        `capability "${id}" pins unknown scope "${override}" in ENTRY_SCOPE_OVERRIDES`,
      );
      return;
    }
    const isRead = accessResolution.access === "read";
    // The write/consent scope for this entry: an ENTRY_SCOPE_OVERRIDES pin names
    // a stricter consent family for a specific endpoint, else the domain's write
    // bucket. A READ capability resolves to that scope's read tier; a WRITE to
    // the scope itself, so scope depends on (access, domain), not domain alone.
    const consentScope = override ?? scopeResolution.writeScope;
    const accessBaseScope = isRead
      ? readScopeForDomainScope(consentScope)
      : consentScope;
    // The base the domain resolves to WITHOUT the override, for the stale-pin
    // check below (a pin that changes nothing is fail-open clutter).
    const domainBaseScope = isRead
      ? scopeResolution.readScope
      : scopeResolution.writeScope;

    let scope = accessBaseScope;
    let additionalScopes: readonly string[] = [];
    if (
      endpoint.exposure.type === "tool" ||
      endpoint.exposure.type === "covered"
    ) {
      const toolName =
        endpoint.exposure.type === "tool"
          ? endpoint.exposure.name
          : endpoint.exposure.by;
      const entryScope = resolveEntryScopeAgainstTool({
        id,
        base: accessBaseScope,
        toolName,
        toolScope: toolScopeByName.get(toolName),
      });
      if (entryScope.status === "error") {
        errors.push(entryScope.message);
        return;
      }
      scope = entryScope.scope;
      const coveringAdditionalScopes = toolAdditionalScopesByName.get(toolName);
      if (coveringAdditionalScopes === undefined) {
        errors.push(
          `capability "${id}" references unknown covering tool "${toolName}"`,
        );
        return;
      }
      additionalScopes = [...new Set(coveringAdditionalScopes)].filter(
        (requiredScope) => requiredScope !== scope,
      );
      if (override !== undefined) {
        // The pin is "used" only when it changed the outcome; a pin the domain
        // scope would have resolved identically without is stale.
        const withoutPin = resolveEntryScopeAgainstTool({
          id,
          base: domainBaseScope,
          toolName,
          toolScope: toolScopeByName.get(toolName),
        });
        if (
          withoutPin.status === "error" ||
          withoutPin.scope !== entryScope.scope
        ) {
          scopeOverrideUses.add(id);
        }
      }
    } else if (override !== undefined && accessBaseScope !== domainBaseScope) {
      scopeOverrideUses.add(id);
    }

    const inputSchema = buildInputSchema(endpoint.config);
    const compactedInputSchema = compactInputSchemaGuarded({
      errors,
      id,
      inputSchema,
    });
    // Transport disposition: parsed from the handler config, then bound to the
    // LIVE (pre-compaction) schema so the check reads the same fields the
    // handler declares. A malformed or contradicted declaration fails the
    // export rather than shipping a catalog entry that misdescribes what the
    // generic transport can carry.
    const transportParse = parseCapabilityTransport(
      endpoint.config["transport"],
    );
    if (transportParse.status === "malformed") {
      errors.push(
        `capability "${id}" has a malformed \`transport\` declaration; see CapabilityTransport in apps/api/src/lib/capability-transport.ts`,
      );
      return;
    }
    const { transport } = transportParse;
    const transportErrors = checkTransportAgainstDerived({
      id,
      transport,
      binaryScan: scanBinarySchemaFields(inputSchema),
    });
    for (const message of transportErrors) {
      errors.push(message);
    }
    if (transportErrors.length > 0) {
      return;
    }
    // Deployment feature gate: the covering tool's flag wins (mechanical
    // inheritance), the reviewed domain table covers the rest.
    const coveringToolName = coveringToolOf(endpoint.exposure);
    const inheritedFeature =
      coveringToolName === undefined
        ? undefined
        : toolFeatureByName.get(coveringToolName);
    entries.push(
      buildCatalogEntry({
        id,
        description: readDescription(endpoint.config),
        kind: kindResolution.kind,
        access: accessResolution,
        scope,
        additionalScopes,
        hasPermissions,
        permissions,
        compactedInputSchema,
        exposure: endpoint.exposure,
        feature: inheritedFeature ?? DOMAIN_FEATURE[domain],
        transport,
      }),
    );
    dispatchRecords.push({
      id,
      importPath: deriveHandlerImportPath(endpoint.file),
      exportName: endpoint.exportName,
    });
    const source = sourceByFile.get(endpoint.file);
    if (source !== undefined) {
      entrySources.push({ id, source });
    }
  };

  for (const endpoint of endpoints) {
    projectEndpoint(endpoint);
  }

  // Class guards over the built entries (context-fidelity, file-response,
  // route-hook, archived-flag). Extracted to keep buildCatalog's complexity in
  // check; each pushes reviewer-actionable errors that fail the export.
  for (const message of collectClassGuardErrors({
    entries,
    entrySources,
    routeFiles: files.filter((file) => file.id.endsWith("routes.ts")),
    toolFeatureByName,
  })) {
    errors.push(message);
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
  for (const id of Object.keys(ENTRY_SCOPE_OVERRIDES)) {
    if (!scopeOverrideUses.has(id)) {
      errors.push(
        `stale ENTRY_SCOPE_OVERRIDES entry "${id}": the domain scope resolves identically without it (remove it)`,
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
  dispatchRecords.sort((a, b) => a.id.localeCompare(b.id));
  return {
    entries,
    dispatchRecords,
    errors,
    internalWaiverCounts,
  };
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

/** Collect every capability leaf's real command path from the generated tree. */
const collectCapabilityCommandPaths = (
  node: RouteNode,
  into: Map<string, readonly string[]>,
): void => {
  if (node.kind === "capability-leaf") {
    into.set(node.spec.capabilityId, node.spec.commandPath);
    return;
  }
  if (node.kind === "route") {
    for (const child of Object.values(node.children)) {
      collectCapabilityCommandPaths(child, into);
    }
  }
};

type CliCommandPathsResult = {
  cliCommandPathById: Map<string, readonly string[]>;
  errors: string[];
};

/**
 * The REAL generated CLI command path per capability id, for the coverage doc:
 * run the CLI's own `buildCliRouteTree` over the same inputs codegen consumes —
 * the live tool registry (the source `registry-snapshot.json` is projected
 * from) plus the just-serialized catalog, revalidated through the CLI's own
 * `parseCapabilityCatalog` so both sides see the identical projection. Curated
 * commands win collisions and a colliding capability relocates under
 * `stella capability <domain> <action>`, exactly as in the shipped CLI.
 * Registry imports stay dynamic so the env is seeded before the module graph
 * validates it (same ordering as buildCatalog).
 */
const computeCliCommandPaths = async (
  serializedCatalog: string,
): Promise<CliCommandPathsResult> => {
  const errors: string[] = [];
  const cliCommandPathById = new Map<string, readonly string[]>();

  const cliEntries = parseCapabilityCatalog(JSON.parse(serializedCatalog));
  if (cliEntries === null) {
    errors.push(
      "coverage doc: the generated catalog failed the CLI's parseCapabilityCatalog validation; fix the exporter/loader mismatch",
    );
    return { cliCommandPathById, errors };
  }

  const { DEFAULT_MCP_TOOL_DEFINITIONS: narrowToolDefinitions } =
    await import("../src/mcp/static-tool-definitions");
  const { DEFAULT_MCP_CLI_ANNOTATIONS } =
    await import("../src/mcp/static-cli-metadata");
  const toolDefinitions: readonly McpToolDefinition[] = narrowToolDefinitions;
  const listings = toolDefinitions.map((tool) => {
    const listing: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: {
        title: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
      };
    } = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.annotations.title },
    };
    if (tool.annotations.readOnlyHint !== undefined) {
      listing.annotations.readOnlyHint = tool.annotations.readOnlyHint;
    }
    if (tool.annotations.destructiveHint !== undefined) {
      listing.annotations.destructiveHint = tool.annotations.destructiveHint;
    }
    return listing;
  });

  const built = Result.try(() =>
    buildCliRouteTree({
      listings,
      annotations: DEFAULT_MCP_CLI_ANNOTATIONS,
      entries: cliEntries,
    }),
  );
  if (Result.isError(built)) {
    errors.push(
      `coverage doc: buildCliRouteTree failed: ${built.error instanceof Error ? built.error.message : String(built.error)}`,
    );
    return { cliCommandPathById, errors };
  }
  collectCapabilityCommandPaths(built.value.tree, cliCommandPathById);
  return { cliCommandPathById, errors };
};

const main = async (): Promise<number> => {
  const checkMode = process.argv.includes("--check");
  const { entries, dispatchRecords, errors, internalWaiverCounts } =
    await buildCatalog();

  if (errors.length > 0) {
    printErrors(errors);
    return 1;
  }

  const serialized = serializeCatalog(entries);
  const dispatchSerialized = await formatGeneratedArtifact(
    serializeDispatchModule(dispatchRecords),
    "capability-dispatch.ts",
  );

  const { cliCommandPathById, errors: pathErrors } =
    await computeCliCommandPaths(serialized);
  // Reachability agreement, asserted in BOTH directions over the real generated
  // route tree: the set of capability entries this exporter calls invocable must
  // equal the set the CLI generator actually emitted leaves for. That is what
  // binds `isTransportInvocable` here to the CLI's mirrored copy of the same
  // predicate — a divergence (a suppressed entry leaking into the CLI, or a
  // fileless-exposed entry silently dropped) fails the export instead of
  // shipping a doc row with a wrong or absent invocation.
  const invocableIds = new Set(
    entries
      .filter(
        (entry) =>
          entry.mcp.type === "capability" &&
          isTransportInvocable(entry.transport),
      )
      .map((entry) => entry.id),
  );
  for (const id of invocableIds) {
    if (!cliCommandPathById.has(id)) {
      pathErrors.push(
        `capability "${id}" is invocable over the generic transport but the CLI generator emitted no command for it; the CLI's transport predicate disagrees with apps/api/src/lib/capability-transport.ts`,
      );
    }
  }
  for (const entry of entries) {
    if (
      entry.mcp.type === "capability" &&
      !invocableIds.has(entry.id) &&
      cliCommandPathById.has(entry.id)
    ) {
      pathErrors.push(
        `capability "${entry.id}" is not invocable over the generic transport but the CLI generator emitted a command for it; the CLI's transport predicate disagrees with apps/api/src/lib/capability-transport.ts`,
      );
    }
  }
  if (pathErrors.length > 0) {
    printErrors(pathErrors);
    return 1;
  }

  // Formatted here for the same reason as the dispatch module: an unformatted
  // artifact fails CI's Format gate, and hand-formatting it afterwards makes it
  // differ from what this exporter regenerates, which then fails the drift
  // guard instead. Only generator-formatted output satisfies both.
  const doc = await formatGeneratedArtifact(
    serializeCoverageDoc({
      entries,
      cliCommandPathById,
      internalWaiverCounts,
    }),
    "capability-coverage.md",
  );

  if (!checkMode) {
    await Bun.write(CATALOG_PATH, serialized);
    await Bun.write(DISPATCH_PATH, dispatchSerialized);
    await Bun.write(COVERAGE_DOC_PATH, doc);
    process.stderr.write(
      `export-capability-catalog: wrote ${entries.length} capabilities to ${CATALOG_PATH}, ${DISPATCH_PATH}, and ${COVERAGE_DOC_PATH}\n`,
    );
    return 0;
  }

  const committedText = await Bun.file(CATALOG_PATH)
    .text()
    .catch(() => null);
  const committedDispatch = await Bun.file(DISPATCH_PATH)
    .text()
    .catch(() => null);
  const committedDoc = await Bun.file(COVERAGE_DOC_PATH)
    .text()
    .catch(() => null);
  if (
    committedText === serialized &&
    committedDispatch === dispatchSerialized &&
    committedDoc === doc
  ) {
    console.log(
      `export-capability-catalog: OK. ${entries.length} capabilities, catalog, dispatch module, and coverage doc are up to date.`,
    );
    return 0;
  }

  if (committedDispatch !== dispatchSerialized) {
    console.error(
      "\nexport-capability-catalog: committed capability-dispatch.ts is out of date. Regenerate with:\n  bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts",
    );
  }

  if (committedDoc !== doc) {
    console.error(
      "\nexport-capability-catalog: docs/capability-coverage.md is out of date. Regenerate with:\n  bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts",
    );
  }

  if (committedText !== serialized) {
    const committed = await parseCommitted();
    if (committed === null) {
      console.error(
        "\nexport-capability-catalog: committed catalog is missing or malformed. Regenerate with:\n  bun --env-file=apps/api/.env apps/api/scripts/export-capability-catalog.ts",
      );
      return 1;
    }
    summarizeDrift(committed, entries);
  }
  return 1;
};

// The handler graph transitively opens a Redis subscriber (lib/sse.ts) at import
// time and never unrefs it, so this one-off script's event loop would hang. The
// work is done here; exit explicitly like export-mcp-tool-registry.ts.
process.exit(await main());
