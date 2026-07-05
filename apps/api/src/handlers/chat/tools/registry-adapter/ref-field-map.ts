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
   * UUID-bearing output paths intentionally left un-refed, each with a
   * rationale in a comment. Forces an explicit decision per tool: an id here is
   * either a non-tenant handle (user/invoice/template/audit/public-corpus id)
   * or an entity id whose owning workspace is not statically recoverable and is
   * deferred to the manifest-swap step. Documentation only; never walked.
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
  // instead, so these are kept off the chat surface.
  fetch: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "id (entity handle)",
      "url (embeds workspace + entity UUIDs)",
    ],
  },
  search: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "results[].id (entity handle)",
      "results[].url (embeds workspace + entity UUIDs)",
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
        path: "overview.recentEntities[].id",
        // Detail mode: every recent entity belongs to the one matter this
        // response describes, so its workspace is the payload's `matter.id`.
        workspace: { from: "outputPath", path: "matter.id" },
      },
    ],
    passthroughIdPaths: [
      "contacts[].workspaceContactId (matter-contact link handle, no chat ref kind)",
      "members[].userId (user handle, no chat ref kind)",
      "nextCursor (opaque base64 cursor; not UUID-formatted)",
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
    passthroughIdPaths: [
      "nextCursor (opaque [createdAt, id] cursor; embeds an entity id, not UUID-formatted)",
    ],
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
    passthroughIdPaths: [
      "version.id / versions[].id (entity-version handles, no chat ref kind)",
      "fields[].id (field row handles, no chat ref kind)",
    ],
  },
  list_properties: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [{ kind: "property", path: "properties[].id" }],
    passthroughIdPaths: [
      "nextCursor (opaque [createdAt, id] cursor; not UUID-formatted)",
    ],
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
    ],
    passthroughIdPaths: [
      // A linked entity's owning workspace is the task's matter, which detail
      // mode does not surface and does not require `matter_id` to reach. Minting
      // its ref needs the extra lookup the manifest-swap step adds; deferred.
      "task.links[].entity.id (linked entity id; owning workspace not statically recoverable)",
      "task.assignees[].userId (user handle, no chat ref kind)",
      "task.links[].linkId (entity-link handle, no chat ref kind)",
    ],
  },

  // --- Knowledge: org-scoped handles, no tenant refs ------------------------
  // Clause and playbook ids are org-scoped library handles the model passes
  // back verbatim; they are not one of the four tenant ref kinds.
  list_clauses: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "clauses[].id / clause.id (clause handle)",
      "clause.variants[].id, version ids, category ids (library handles)",
    ],
  },
  list_playbooks: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: ["items[].id / playbook.id (playbook handle)"],
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
    passthroughIdPaths: [
      "entries[].id / entry.id (time-entry handles)",
      "entries[].userId / entry.userId (user handles)",
      "nextCursor (opaque [dateWorked, id] cursor; not UUID-formatted)",
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
    passthroughIdPaths: [
      "invoices[].id / invoice.id (invoice handles)",
      "invoice.timeEntries[].id, invoice.expenses[].id (line-item handles)",
      "nextCursor (opaque [createdAt, id] cursor; not UUID-formatted)",
    ],
  },
  get_usage: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "entitlement.id, policy.id (org billing-plan ids, not tenant refs)",
    ],
  },

  // --- Public corpora: public ids, no tenant refs ---------------------------
  search_case_law: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "results[].decisionId, source_id (public case-law corpus ids)",
    ],
  },
  read_case_law_decision: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "decision.decisionId, decision_id (public case-law corpus ids)",
    ],
  },
  search_legislation: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [
      "lawId, blockId (public BOE statute ids, not tenant refs)",
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
    passthroughIdPaths: [
      "templates[].id / template_id (org template handle, no chat ref kind)",
    ],
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
    passthroughIdPaths: [
      "items[].workspaceId, items[].resourceId (polymorphic), metadata, changes (unenumerable tenant payload)",
    ],
  },
} as const satisfies Record<RegistryReadToolName, RegistryRefFieldMapEntry>;
