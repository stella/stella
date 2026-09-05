import type { GenericSchema, InferInput } from "valibot";

import type {
  ChatProjectionSchema,
  RegistryRefKind,
} from "@/api/lib/chat/projection-schema";
import {
  DELETED_TRUE_PROJECTION,
  DELETE_TIME_ENTRY_PROJECTION,
  GET_USAGE_PROJECTION,
  LINK_MATTER_CONTACT_PROJECTION,
  LIST_CLAUSES_PROJECTION,
  LIST_CONTACTS_PROJECTION,
  LIST_DOCUMENTS_PROJECTION,
  LIST_INVOICES_PROJECTION,
  LIST_MATTERS_PROJECTION,
  LIST_PLAYBOOKS_PROJECTION,
  LIST_PROPERTIES_PROJECTION,
  LIST_TASKS_PROJECTION,
  LIST_TEMPLATES_PROJECTION,
  LIST_TIME_ENTRIES_PROJECTION,
  LOOKUP_BUSINESS_REGISTRY_PROJECTION,
  MANAGE_ORGANIZATION_PROJECTION,
  READ_CASE_LAW_DECISION_PROJECTION,
  READ_CONTACT_PROJECTION,
  READ_CONTENT_ACROSS_MATTERS_PROJECTION,
  READ_DOCUMENT_PROJECTION,
  RUN_PLAYBOOK_PROJECTION,
  SAVE_CLAUSE_PROJECTION,
  SAVE_CONTACT_PROJECTION,
  SAVE_DOCUMENT_PROJECTION,
  SAVE_MATTER_PROJECTION,
  SAVE_TASK_PROJECTION,
  SAVE_TEMPLATE_PROJECTION,
  SAVE_TIME_ENTRY_PROJECTION,
  SEARCH_ACROSS_MATTERS_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
  SEARCH_LEGISLATION_PROJECTION,
  SET_FIELD_VALUE_PROJECTION,
  SET_PRACTICE_JURISDICTIONS_PROJECTION,
} from "@/api/lib/chat/projections";
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
 * The write slice of the MCP registry, derived structurally the same way the
 * read slice is: filtering the single-source `as const` registry array by
 * `{ access: "write" }` yields exactly the write-tool name union. A newly added
 * write tool widens this union, which makes the `satisfies` on
 * `WRITE_TOOL_REF_FIELD_MAP` below fail typecheck until an explicit ref decision
 * is recorded for it, so a future write tool cannot be silently missed from the
 * chat projection.
 */
type WriteToolDefinition = Extract<
  (typeof DEFAULT_MCP_TOOL_DEFINITIONS)[number],
  { access: "write" }
>;

export type RegistryWriteToolName = WriteToolDefinition["name"];

/** One input parameter that accepts a chat ref, and the id kind it resolves to. */
export type InputRefParam = { kind: RegistryRefKind; param: string };

/**
 * The ref-mediation contract of one chat-projected tool: the input refs to
 * dehydrate, plus the projection schema that is the single output-side
 * artifact. `projectForChat` applies the schema in one pass (strict parse,
 * strip, ref hydration, UUID invariant), so an undeclared handler field is
 * structurally unable to reach the model. Hand-written path lists are
 * deliberately unrepresentable here: there is no field to put them in, so a
 * new tool cannot reintroduce the hand-maintained mirror this map used to be.
 */
export type RefMediationEntry = {
  inputRefs: readonly InputRefParam[];
  projection: ChatProjectionSchema;
};

/**
 * Per-tool chat decision. `chatProjectable: false` marks a tool deliberately
 * kept off the chat surface (rationale in the entry's comment) and carries
 * nothing else: the orchestrator refuses to dispatch it, so no input refs or
 * projection can apply. `chatProjectable: true` requires the full mediation
 * contract, so a projectable entry without a projection schema cannot compile.
 */
export type RegistryRefFieldMapEntry =
  | { chatProjectable: false }
  | ({ chatProjectable: true } & RefMediationEntry);

export type ChatProjectableToolName<TMap> = {
  [TName in keyof TMap]: TMap[TName] extends { chatProjectable: true }
    ? TName
    : never;
}[keyof TMap];

export type ProjectionDataByName<TMap, TNames extends keyof TMap> = {
  [TName in TNames]: TMap[TName] extends {
    projection: infer TProjection extends GenericSchema;
  }
    ? InferInput<TProjection>
    : never;
};

// --- Chat projection schemas -------------------------------------------------
// One artifact per projected tool: the exact shape the chat surface forwards,
// with per-field chat semantics attached (`chatRef`/`chatEntityRef`/
// `passthroughId`/`strippedField`). `projectForChat` strict-parses each
// payload against its schema (an undeclared handler field fails closed BEFORE
// it can reach the model) and applies the annotations in the same walk, so
// shape and ref decisions cannot drift. Every schema is written from the
// handler's own payload construction (`apps/api/src/mcp/*-tools.ts`), branch
// by branch; per-tool derivation tests in `projection-schema.test.ts` pin
// each schema's derived lists to the hand lists they replaced.

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
  // instead, so these are kept off the chat surface: the orchestrator refuses
  // the tool before any projection could run.
  fetch: { chatProjectable: false },
  search: { chatProjectable: false },

  // --- Matters / contacts / content -----------------------------------------
  list_matters: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: LIST_MATTERS_PROJECTION,
  },
  list_contacts: {
    chatProjectable: true,
    inputRefs: [],
    projection: LIST_CONTACTS_PROJECTION,
  },
  search_across_matters: {
    chatProjectable: true,
    inputRefs: [],
    projection: SEARCH_ACROSS_MATTERS_PROJECTION,
  },
  read_content_across_matters: {
    chatProjectable: true,
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    projection: READ_CONTENT_ACROSS_MATTERS_PROJECTION,
  },
  read_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    projection: READ_CONTACT_PROJECTION,
  },

  // --- Documents / properties -----------------------------------------------
  list_documents: {
    chatProjectable: true,
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "parent_id" },
    ],
    projection: LIST_DOCUMENTS_PROJECTION,
  },
  read_document: {
    chatProjectable: true,
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    projection: READ_DOCUMENT_PROJECTION,
  },
  list_properties: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: LIST_PROPERTIES_PROJECTION,
  },

  // --- Tasks -----------------------------------------------------------------
  list_tasks: {
    chatProjectable: true,
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "task_id" },
    ],
    projection: LIST_TASKS_PROJECTION,
  },

  // --- Knowledge: org-scoped handles, no tenant refs ------------------------
  // Clause and playbook ids are org-scoped library handles the model passes
  // back verbatim; they are not one of the four tenant ref kinds.
  list_clauses: {
    chatProjectable: true,
    inputRefs: [],
    projection: LIST_CLAUSES_PROJECTION,
  },
  list_playbooks: {
    chatProjectable: true,
    inputRefs: [],
    projection: LIST_PLAYBOOKS_PROJECTION,
  },

  // --- Billing: entity refs on line items, rest are billing handles ---------
  list_time_entries: {
    chatProjectable: true,
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "entity_id" },
    ],
    projection: LIST_TIME_ENTRIES_PROJECTION,
  },
  resolve_rate: {
    // Rate visibility is restricted to billing administrators. The chat
    // prompt is request-independent, so this privileged tool must stay out of
    // both the static prompt catalog and the runtime projected surface.
    chatProjectable: false,
  },
  list_invoices: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: LIST_INVOICES_PROJECTION,
  },
  get_usage: {
    chatProjectable: true,
    inputRefs: [],
    projection: GET_USAGE_PROJECTION,
  },

  // --- Public corpora: public ids, no tenant refs ---------------------------
  search_case_law: {
    chatProjectable: true,
    inputRefs: [],
    projection: SEARCH_CASE_LAW_PROJECTION,
  },
  read_case_law_decision: {
    chatProjectable: true,
    inputRefs: [],
    projection: READ_CASE_LAW_DECISION_PROJECTION,
  },
  search_legislation: {
    chatProjectable: true,
    inputRefs: [],
    projection: SEARCH_LEGISLATION_PROJECTION,
  },
  lookup_business_registry: {
    chatProjectable: true,
    inputRefs: [],
    projection: LOOKUP_BUSINESS_REGISTRY_PROJECTION,
  },

  // --- Templates: org-scoped template handles -------------------------------
  list_templates: {
    chatProjectable: true,
    inputRefs: [],
    projection: LIST_TEMPLATES_PROJECTION,
  },

  // --- Audit log: not projected to chat -------------------------------------
  // Excluded from the anonymized surface (`dynamic_tenant_payload`) for the
  // same reason it cannot be safely ref-mediated: `metadata`/`changes` are
  // free-form JSON that may embed any tenant id or tenant text under keys the
  // walker cannot enumerate, `items[].resourceId` is polymorphic (its kind
  // depends on `resource_type`), and `nextCursor` embeds the audit-log id
  // verbatim. Static field mapping cannot guarantee no tenant UUID leaks, so
  // it stays off the chat surface until a payload-shaping step handles it.
  list_audit_log: { chatProjectable: false },

  // --- Capability meta-tools: not projected to chat -------------------------
  // The generic capability surface (list/describe/invoke) is reached over the
  // MCP/CLI transport, never from chat: chat has its own curated tool set and
  // the generic path cannot prove per-capability ref safety.
  list_capabilities: { chatProjectable: false },
  describe_capability: { chatProjectable: false },
} as const satisfies Record<RegistryReadToolName, RegistryRefFieldMapEntry>;

/**
 * Per-tool ref decision for every write tool in the MCP registry. Keyed by the
 * derived `RegistryWriteToolName` union via `satisfies`, so the map is
 * exhaustive by construction: a write tool with no entry here cannot compile,
 * which is the class-guard that stops a future write tool being silently left
 * out of the chat projection.
 */
export const WRITE_TOOL_REF_FIELD_MAP = {
  // --- Matters / contacts / tasks -------------------------------------------
  save_matter: {
    chatProjectable: true,
    // `client_id` is a contact ref; other fields are plain data.
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "contact", param: "client_id" },
    ],
    projection: SAVE_MATTER_PROJECTION,
  },
  delete_matter: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: DELETED_TRUE_PROJECTION,
  },
  save_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    projection: SAVE_CONTACT_PROJECTION,
  },
  delete_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    projection: DELETED_TRUE_PROJECTION,
  },
  save_task: {
    chatProjectable: true,
    // `task_id` and `link_entity_id` are entity refs; `matter_id` a matter ref.
    // `add_assignee_user_id`/`remove_assignee_user_id` are user handles and
    // `unlink_link_id` is an entity-link handle: none carry a chat ref kind, so
    // they pass through as-is.
    inputRefs: [
      { kind: "entity", param: "task_id" },
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "link_entity_id" },
    ],
    projection: SAVE_TASK_PROJECTION,
  },
  link_matter_contact: {
    chatProjectable: true,
    // `workspace_contact_id` is the matter-contact join-row handle, not a chat
    // ref, so it passes through as-is.
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "contact", param: "contact_id" },
    ],
    projection: LINK_MATTER_CONTACT_PROJECTION,
  },

  // --- Documents / properties -----------------------------------------------
  save_document: {
    chatProjectable: true,
    // `entity_id` and `parent_id` are entity refs; `matter_id` a matter ref.
    // `version_id` is an entity-version handle, not a chat ref: passes through.
    inputRefs: [
      { kind: "entity", param: "entity_id" },
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "parent_id" },
    ],
    projection: SAVE_DOCUMENT_PROJECTION,
  },
  // In-app chat already owns the active-document edit/version flow, including
  // its file overlay and approval UI. The MCP App is a host transport adapter,
  // not a second in-app tool; keeping this explicit false still makes every new
  // registry write take a compile-time projection decision.
  upload_document_version: { chatProjectable: false },
  open_document_version_upload: { chatProjectable: false },
  delete_document: {
    chatProjectable: true,
    // `version_id` is an entity-version handle: passes through.
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    projection: DELETED_TRUE_PROJECTION,
  },
  delete_task: {
    chatProjectable: true,
    inputRefs: [{ kind: "entity", param: "task_id" }],
    projection: DELETED_TRUE_PROJECTION,
  },
  set_field_value: {
    chatProjectable: true,
    // The only write tool with a `property` input ref (called out in
    // `ref-mediation.ts`'s dehydration core). `content` is a plain field value.
    inputRefs: [
      { kind: "entity", param: "entity_id" },
      { kind: "property", param: "property_id" },
    ],
    projection: SET_FIELD_VALUE_PROJECTION,
  },

  // --- Billing --------------------------------------------------------------
  save_time_entry: {
    chatProjectable: true,
    // `time_entry_id` is a billing handle (passes through); `timezone_id` is an
    // IANA tz string, not an id.
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "entity", param: "entity_id" },
    ],
    projection: SAVE_TIME_ENTRY_PROJECTION,
  },
  delete_time_entry: {
    chatProjectable: true,
    inputRefs: [],
    projection: DELETE_TIME_ENTRY_PROJECTION,
  },

  // --- Knowledge ------------------------------------------------------------
  save_clause: {
    chatProjectable: true,
    // `clause_id` and `category_id` are org-scoped library handles, not chat
    // refs: they pass through as-is.
    inputRefs: [],
    projection: SAVE_CLAUSE_PROJECTION,
  },
  delete_clause: {
    chatProjectable: true,
    inputRefs: [],
    projection: DELETED_TRUE_PROJECTION,
  },
  run_playbook: {
    chatProjectable: true,
    // `playbook_id` is an org-scoped library handle: passes through.
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: RUN_PLAYBOOK_PROJECTION,
  },

  // --- Organization ---------------------------------------------------------
  manage_organization: {
    chatProjectable: true,
    // `user_id` is a workspace-member (user) handle, not a chat ref: passes
    // through. `matter_id` is a matter ref (used by the add/remove member
    // actions that scope to a matter).
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: MANAGE_ORGANIZATION_PROJECTION,
  },

  // --- Practice profile -----------------------------------------------------
  set_practice_jurisdictions: {
    chatProjectable: true,
    inputRefs: [],
    projection: SET_PRACTICE_JURISDICTIONS_PROJECTION,
  },

  // --- Templates ------------------------------------------------------------
  // `fill_template` is already served by the hand-written chat tool in
  // `createTemplateTools` (AI-fillable fields, shared with the REST fill
  // routes), so projecting it from the registry would collide on the tool name.
  // It stays off the registry write projection (`chatProjectable: false`) and
  // is instead classified `mutation` in the chat tool-policy map so the
  // existing tool still asks for approval before filling. Its input
  // `template_id` is a template handle (not a chat ref) either way.
  fill_template: { chatProjectable: false },
  // Compound template persistence is an MCP/CLI convenience for clients that
  // cannot PUT bytes. Chat already has first-class template/document flows;
  // projecting this would duplicate that surface and its approval UX.
  save_filled_template: { chatProjectable: false },
  save_template: {
    chatProjectable: true,
    // `template_id` is an org template handle, not a chat ref: passes through.
    inputRefs: [],
    projection: SAVE_TEMPLATE_PROJECTION,
  },

  // --- Feedback -------------------------------------------------------------
  // `send_feedback` is an agent/MCP tool that reports bugs to the maintainers
  // and runs its own human-approval handshake (preview -> confirmation token).
  // It is not a chat surface tool: it takes no entity references, returns no
  // tenant ids, and would double-gate on approval if projected. It stays off
  // the chat write projection, so it never enters `ProjectedWriteToolName` or
  // the chat tool-policy map.
  send_feedback: { chatProjectable: false },

  // --- Capability meta-tool: not projected to chat --------------------------
  // `invoke_capability` runs an arbitrary catalog capability over the MCP/CLI
  // transport; its authority is enforced per capability inside the handler, and
  // it is never dispatched from chat.
  invoke_capability: { chatProjectable: false },
} as const satisfies Record<RegistryWriteToolName, RegistryRefFieldMapEntry>;
