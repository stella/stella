import type { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

/**
 * The read-only slice of the MCP registry, derived structurally from the single
 * source of truth. `DEFAULT_MCP_TOOL_DEFINITIONS` is declared `as const`, so its
 * element union carries each tool's literal `access`, and filtering by
 * `{ access: "read" }` yields exactly the read-tool name union. A newly added
 * read tool widens this union, which makes the `satisfies` on
 * `READ_TOOL_REF_FIELD_MAP` below fail typecheck until an explicit ref decision
 * is recorded for it: the same class-guard shape the anonymized projection uses.
 */
type ReadToolDefinition = Extract<
  (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number],
  { access: "read" }
>;

export type RegistryReadToolName = ReadToolDefinition["name"];

/**
 * The four tenant-content id kinds the chat ref registry mediates
 * (`createChatRefRegistry`). Every other id a registry handler emits (user,
 * task-link, invoice, time-entry, template, clause, playbook, audit-log,
 * usage-plan, or public case-law/BOE corpus id) is a handle the model may pass
 * back verbatim, not a tenant-content reference, so it stays outside this set.
 */
export type RegistryRefKind = "matter" | "entity" | "contact" | "property";

type SimpleRefKind = Exclude<RegistryRefKind, "entity">;

/**
 * How an entity output ref recovers its owning workspace id, which
 * `toEntityRef` needs alongside the entity id. MCP handlers name these fields
 * differently per tool (a sibling `workspaceId`, a fixed `matter.id`, or the
 * tool's resolved `matter_id` input), so the source is declared per field
 * rather than guessed from key names.
 */
export type EntityWorkspaceSource =
  | { from: "sibling"; key: string }
  | { from: "outputPath"; path: string }
  | { from: "inputParam"; param: string }
  // The output entity is a *different* entity than the request's own entity
  // input named by `param`, but is validated (at write time, outside this
  // orchestrator) to share its workspace, e.g. a task's linked entities. The
  // workspace is the one already resolved when `param`'s ref was dehydrated,
  // not a fresh lookup.
  | { from: "inputEntityWorkspace"; param: string }
  // The output entity IS the request's own entity input; the orchestrator
  // reuses the ref it dehydrated on the way in, so no workspace lookup runs.
  | { from: "inputEntity"; param: string };

/**
 * One UUID-bearing output path and the tenant ref kind it carries. `path` uses
 * the same `a.b` / `a[].b` grammar as the egress text-field specs. Entity
 * fields additionally declare where their owning workspace id lives.
 */
export type OutputRefField =
  | { kind: SimpleRefKind; path: string }
  | { kind: "entity"; path: string; workspace: EntityWorkspaceSource };

/** One input parameter that accepts a chat ref, and the id kind it resolves to. */
export type InputRefParam = { kind: RegistryRefKind; param: string };

export type RegistryRefFieldMapEntry = {
  /**
   * Whether chat may project this read tool at all. `false` marks a read tool
   * deliberately kept off the chat surface (rationale in the entry's comment);
   * the orchestrator refuses to dispatch it, so a tool that cannot satisfy the
   * "no tenant UUID reaches the model" invariant by static field mapping is
   * never reachable from chat.
   */
  chatProjectable: boolean;
  inputRefs: readonly InputRefParam[];
  outputRefs: readonly OutputRefField[];
  /**
   * UUID-bearing output paths intentionally left un-refed. Each path uses the
   * same `a.b` / `a[].b` grammar as `outputRefs`. Forces an explicit decision
   * per tool: an id here is either a non-tenant handle (user/invoice/
   * template/audit/public-corpus id) or an entity id whose owning workspace is
   * not statically recoverable and is deferred to the manifest-swap step.
   *
   * Load-bearing, not documentation: `findUndeclaredUuidPath`
   * (`ref-mediation.ts`) walks the hydrated payload and allows a surviving
   * raw uuid only at one of these exact paths. An `outputRefs` path is
   * deliberately NOT part of this allowlist — hydration must have already
   * rewritten it to a chat ref, so a uuid still there means hydration missed
   * it, which fails closed the same as an undeclared path.
   */
  passthroughIdPaths: readonly string[];
};

/**
 * Per-tool ref decision for every read tool in the MCP registry. Keyed by the
 * derived `RegistryReadToolName` union via `satisfies`, so the map is
 * exhaustive by construction: a read tool with no entry here cannot compile.
 */
export const READ_TOOL_REF_FIELD_MAP = {
  // --- OpenAI-compat shims: not projected to chat ---------------------------
  // `fetch`/`search` duplicate read_content_across_matters /
  // search_across_matters and additionally emit `url` (and `metadata`) fields
  // that embed raw workspace/entity UUIDs inside a string the ref walker cannot
  // rewrite without reparsing URLs. Chat projects the native equivalents
  // instead, so these are kept off the chat surface: `chatProjectable: false`
  // makes the paths below inert (the orchestrator refuses the tool before the
  // backstop ever walks its payload), they are listed only so the shape stays
  // documented if that ever changes.
  fetch: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: ["id", "url", "workspaceId"],
  },
  search: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "results[].id",
      "results[].url",
      "results[].workspaceId",
    ],
  },

  // --- Matters / contacts / content -----------------------------------------
  list_matters: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [
      { kind: "matter", path: "matters[].id" },
      { kind: "matter", path: "matter.id" },
      { kind: "contact", path: "contacts[].contactId" },
      {
        kind: "entity",
        // The overview handler's item field is `entityId`, not `id`
        // (`readOverviewHandler` returns `{ entityId: e.id, ... }`); the path
        // must match the actual key or the walker silently skips every slot
        // and the raw entity uuid reaches the model.
        path: "overview.recentEntities[].entityId",
        // Detail mode: every recent entity belongs to the one matter this
        // response describes, so its workspace is the payload's `matter.id`.
        workspace: { from: "outputPath", path: "matter.id" },
      },
    ],
    // Matter-contact link ids and workspace member (user) ids are handles
    // with no chat ref kind; `nextCursor` is an opaque base64 cursor (not
    // UUID-formatted).
    passthroughIdPaths: [
      "contacts[].workspaceContactId",
      "members[].userId",
      "nextCursor",
    ],
  },
  search_across_matters: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [
      { kind: "matter", path: "hits[].workspaceId" },
      {
        kind: "entity",
        path: "hits[].entityId",
        workspace: { from: "sibling", key: "workspaceId" },
      },
    ],
    passthroughIdPaths: [],
  },
  read_content_across_matters: {
    chatProjectable: true,
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    outputRefs: [
      { kind: "matter", path: "workspaceId" },
      {
        kind: "entity",
        path: "entityId",
        workspace: { from: "sibling", key: "workspaceId" },
      },
    ],
    passthroughIdPaths: [],
  },
  read_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    outputRefs: [{ kind: "contact", path: "contactId" }],
    passthroughIdPaths: [],
  },

  // --- Documents / properties -----------------------------------------------
  list_documents: {
    chatProjectable: true,
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "parent_id" },
    ],
    outputRefs: [
      {
        kind: "entity",
        path: "documents[].id",
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "documents[].parentId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
    ],
    // Opaque `[createdAt, id]` cursor; embeds an entity id, not UUID-formatted.
    passthroughIdPaths: ["nextCursor"],
  },
  read_document: {
    chatProjectable: true,
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    outputRefs: [
      {
        kind: "entity",
        path: "entityId",
        workspace: { from: "inputEntity", param: "entity_id" },
      },
      { kind: "property", path: "fields[].propertyId" },
      { kind: "property", path: "version.fields[].propertyId" },
    ],
    // Entity-version handles (`version.id`/`versions[].id`, the specific-
    // version branch's own `version.fields[].id`, and the diff branch's
    // `diff.baseVersionId`/`diff.targetVersionId`), field-row handles
    // (`fields[].id`), and `versionsNextCursor`, an opaque
    // `[versionNumber, entityVersionId]` cursor — none carry a chat ref kind.
    passthroughIdPaths: [
      "version.id",
      "versions[].id",
      "version.fields[].id",
      "fields[].id",
      "diff.baseVersionId",
      "diff.targetVersionId",
      "versionsNextCursor",
    ],
  },
  list_properties: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [{ kind: "property", path: "properties[].id" }],
    // Opaque `[createdAt, id]` cursor; not UUID-formatted.
    passthroughIdPaths: ["nextCursor"],
  },

  // --- Tasks -----------------------------------------------------------------
  list_tasks: {
    chatProjectable: true,
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "task_id" },
    ],
    outputRefs: [
      {
        kind: "entity",
        path: "tasks[].id",
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "task.taskId",
        workspace: { from: "inputEntity", param: "task_id" },
      },
      {
        kind: "entity",
        path: "task.links[].entity.id",
        // Entity links are validated same-workspace at creation:
        // `createEntityLinkHandler` (entity-links-create.ts, shared by the
        // HTTP route and save_task) looks up both the source and target
        // entities scoped to one ambient `workspaceId` before inserting the
        // link row, so a linked entity always belongs to the task's own
        // workspace. Detail mode only reaches this path via `task_id`
        // (list mode's `tasks[]` carries no `links`), so the workspace
        // already resolved for that input entity is the correct source.
        workspace: { from: "inputEntityWorkspace", param: "task_id" },
      },
    ],
    // Assignee ids are user handles, link ids are entity-link handles
    // (neither carries a chat ref kind); `nextCursor` is an opaque
    // `[createdAt, id]` cursor embedding an entity id, not UUID-formatted.
    passthroughIdPaths: [
      "task.assignees[].userId",
      "task.links[].linkId",
      "nextCursor",
    ],
  },

  // --- Knowledge: org-scoped handles, no tenant refs ------------------------
  // Clause and playbook ids are org-scoped library handles the model passes
  // back verbatim; they are not one of the four tenant ref kinds.
  list_clauses: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Clause, category, variant, and clause-version ids are org-scoped
    // library handles; `clause.createdBy` is the authoring user's id (a
    // `text` column, not a uuid column, but declared defensively in case a
    // deployment's user ids happen to be uuid-shaped); `nextCursor` is an
    // opaque `${isoDate}|${clauseId}` cursor.
    passthroughIdPaths: [
      "clauses[].id",
      "clauses[].categoryId",
      "clause.id",
      "clause.categoryId",
      "clause.variants[].id",
      "clause.versions[].id",
      "clause.createdBy",
      "categories[].id",
      "categories[].parentId",
      "version.id",
      "nextCursor",
    ],
  },
  list_playbooks: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Playbook ids are org-scoped library handles; a position's `sourceId` is
    // a client-supplied stable id; a "clause"-sourced standard's `clauseId`
    // is the same clause-library handle `list_clauses` declares.
    passthroughIdPaths: [
      "items[].id",
      "playbook.id",
      "playbook.positions.items[].sourceId",
      "playbook.positions.items[].standard.clauseId",
      "nextCursor",
    ],
  },

  // --- Billing: entity refs on line items, rest are billing handles ---------
  list_time_entries: {
    chatProjectable: true,
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "entity_id" },
    ],
    outputRefs: [
      {
        kind: "entity",
        path: "entries[].entityId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "entry.entityId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
    ],
    // Time-entry ids and user ids carry no chat ref kind; `nextCursor` is an
    // opaque `[dateWorked, id]` cursor, not UUID-formatted.
    passthroughIdPaths: [
      "entries[].id",
      "entry.id",
      "entries[].userId",
      "entry.userId",
      "nextCursor",
    ],
  },
  resolve_rate: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [],
    passthroughIdPaths: [],
  },
  list_invoices: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [
      {
        kind: "entity",
        path: "invoice.timeEntries[].entityId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "invoice.timeEntries[].entity.id",
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "invoice.expenses[].entityId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "invoice.expenses[].entity.id",
        workspace: { from: "inputParam", param: "matter_id" },
      },
    ],
    // Invoice ids and line-item ids (time entry / expense) carry no chat ref
    // kind; `nextCursor` is an opaque `[createdAt, id]` cursor, not
    // UUID-formatted.
    passthroughIdPaths: [
      "invoices[].id",
      "invoice.id",
      "invoice.timeEntries[].id",
      "invoice.expenses[].id",
      "nextCursor",
    ],
  },
  get_usage: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Org billing-plan ids, not tenant refs.
    passthroughIdPaths: ["entitlement.id", "policy.id"],
  },

  // --- Public corpora: public ids, no tenant refs ---------------------------
  search_case_law: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Public case-law corpus id; `source_id` is a request input, never an
    // output field, so it needs no output-path declaration here.
    passthroughIdPaths: ["results[].decisionId", "nextCursor"],
  },
  read_case_law_decision: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Public case-law corpus ids (decision, citation, and source ids);
    // `decision.metadata` is free-form jsonb straight from the public court
    // source and cannot be enumerated by path (same unenumerable-payload
    // caveat as `list_audit_log`'s `metadata`/`changes`, just over public
    // rather than tenant data).
    passthroughIdPaths: [
      "decision.decisionId",
      "decision.citationsFrom[].id",
      "decision.citationsFrom[].citedDecisionId",
      "decision.citationsTo[].id",
      "decision.citationsTo[].citingDecisionId",
      "decision.source.id",
      "nextCursor",
    ],
  },
  search_legislation: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Public BOE statute ids, not tenant refs. Never actually UUID-formatted
    // (`lawId` is schema-validated against the `BOE-*` id pattern; `blockId`
    // and `data[].identificador` are declared defensively since `blockId` is
    // an unvalidated request-argument echo).
    passthroughIdPaths: [
      "lawId",
      "blockId",
      "law.lawId",
      "data[].identificador",
    ],
  },
  lookup_business_registry: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
  },

  // --- Templates: org-scoped template handles -------------------------------
  list_templates: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Org template handle; `template_id` is a request input, not an output
    // field, so it needs no output-path declaration. Detail mode's describe
    // payload carries no id fields at all.
    passthroughIdPaths: ["templates[].id", "nextCursor"],
  },

  // --- Audit log: not projected to chat -------------------------------------
  // Excluded from the anonymized surface (`dynamic_tenant_payload`) for the
  // same reason it cannot be safely ref-mediated: `metadata`/`changes` are
  // free-form JSON that may embed any tenant id or tenant text under keys the
  // walker cannot enumerate, and `nextCursor` embeds the audit-log id verbatim.
  // Static field mapping cannot guarantee no tenant UUID leaks, so it stays off
  // the chat surface until a payload-shaping step handles it.
  list_audit_log: {
    chatProjectable: false,
    // `resource_id` is polymorphic (its kind depends on `resource_type`), so it
    // is deliberately not declared as any single ref kind; the tool is off the
    // chat surface anyway, so no input dehydration runs.
    inputRefs: [],
    outputRefs: [],
    // `items[].resourceId` is polymorphic and `metadata`/`changes` are
    // unenumerable free-form tenant JSON, so no path list here could make
    // this payload safe to walk. Moot in practice: `chatProjectable: false`
    // means the backstop never runs against this tool's output at all.
    passthroughIdPaths: ["items[].workspaceId", "items[].resourceId"],
  },
} as const satisfies Record<RegistryReadToolName, RegistryRefFieldMapEntry>;
