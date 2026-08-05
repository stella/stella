import * as v from "valibot";

import type { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

import type {
  ChatProjectionSchema,
  RefMediationLists,
  RegistryRefKind,
} from "./projection-schema";
import {
  chatEntityRef,
  chatRef,
  passthroughId,
  strippedField,
} from "./projection-schema";

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
 * The ref-mediation contract shared by the read and write ref-field maps: the
 * input refs to dehydrate, plus the output-side decision. The output side is
 * one of two mutually exclusive artifacts:
 *
 * - a chat projection schema (`projection`), from which the three mediation
 *   lists are derived mechanically (`deriveRefMediationEntry`) and whose
 *   strict parse makes an undeclared handler field structurally unable to
 *   reach the model; or
 * - the hand-written lists (unconverted tools), where the runtime UUID
 *   backstop alone guards undeclared fields.
 *
 * The `never`-typed exclusions make an entry that carries both a projection
 * and hand lists fail typecheck, so a converted tool cannot keep a stale hand
 * copy of what the schema now owns. Resolve the lists for either shape with
 * `resolveMediationLists` (`ref-mediation.ts`); the generic mediation cores
 * (`dehydrateRefs`/`hydrateRefs`/`findUndeclaredUuidPathIn`) read exactly
 * those three lists, so a read entry and a write entry drive the same code.
 */
export type RefMediationEntry = {
  inputRefs: readonly InputRefParam[];
} & (
  | ({ projection?: never } & RefMediationLists)
  | {
      projection: ChatProjectionSchema;
      outputRefs?: never;
      passthroughIdPaths?: never;
      stripPaths?: never;
    }
);

export type RegistryRefFieldMapEntry = RefMediationEntry & {
  /**
   * Whether chat may project this read tool at all. `false` marks a read tool
   * deliberately kept off the chat surface (rationale in the entry's comment);
   * the orchestrator refuses to dispatch it, so a tool that cannot satisfy the
   * "no tenant UUID reaches the model" invariant by static field mapping is
   * never reachable from chat.
   */
  chatProjectable: boolean;
};

// --- Chat projection schemas (converted tools) ------------------------------------
// One artifact per converted tool: the exact shape the chat surface forwards,
// with per-field chat semantics attached (`chatRef`/`chatEntityRef`/
// `passthroughId`/`strippedField`). The strict parse in the orchestrator makes
// an undeclared handler field fail closed BEFORE it can reach the model, and
// `deriveRefMediationEntry` derives the entry's outputRefs/passthrough/strip
// lists from the same annotations, so shape and ref decisions cannot drift.

/**
 * list_matters, list branch. Source of truth: `handleListMattersTool`
 * (`stella-tools.ts`) — one row per matter plus the opaque page cursor.
 */
const listMattersListProjection = v.strictObject({
  matters: v.array(
    v.strictObject({
      // A matter's id IS its workspace id: a matter chat ref.
      id: chatRef("matter"),
      name: v.string(),
      reference: v.string(),
      status: v.string(),
      lastActivityAt: v.string(),
      createdAt: v.string(),
    }),
  ),
  // Opaque base64 cursor (boundary matter id), not UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_matters, detail branch (one matter's overview). Source of truth:
 * `readMatterOverview` (`stella-tools.ts`) composing `readWorkspaceHandler`,
 * `readOverviewHandler` (avatar URLs stripped at the handler), and the
 * contact/member card mappers.
 */
const listMattersDetailProjection = v.strictObject({
  matter: v.strictObject({
    id: chatRef("matter"),
    name: v.string(),
    reference: v.string(),
    status: v.string(),
    clientName: v.nullable(v.string()),
  }),
  overview: v.strictObject({
    entityCount: v.number(),
    documentCount: v.number(),
    taskCount: v.number(),
    recentEntities: v.array(
      v.strictObject({
        // The overview handler's item field is `entityId`, not `id`
        // (`readOverviewHandler` returns `{ entityId: e.id, ... }`). Every
        // recent entity belongs to the one matter this response describes,
        // so its workspace is the payload's `matter.id`.
        entityId: chatEntityRef({ from: "outputPath", path: "matter.id" }),
        name: v.string(),
        kind: v.string(),
        status: v.nullable(v.string()),
        priority: v.nullable(v.string()),
        dueDate: v.nullable(v.string()),
        mimeType: v.nullable(v.string()),
        // The primary-field plumbing ids exist for the web UI (mime icon,
        // click-to-open); chat cannot act on them and they carry raw UUIDs
        // whenever a recent entity has a primary field, which tripped the
        // UUID backstop on every non-empty matter until they were stripped.
        fieldId: strippedField(),
        propertyId: strippedField(),
        pdfFileId: strippedField(),
        encrypted: v.boolean(),
        createdAt: v.string(),
        updatedAt: v.nullable(v.string()),
        createdBy: v.nullable(v.string()),
        createdByDeletedAt: v.nullable(v.string()),
        assignedTo: v.nullable(v.string()),
        assignedToDeletedAt: v.nullable(v.string()),
      }),
    ),
  }),
  contacts: v.array(
    v.strictObject({
      // The matter-contact link id, so link_matter_contact can unlink a
      // precise role even when the contact holds several: a handle, no chat
      // ref kind.
      workspaceContactId: passthroughId(),
      contactId: chatRef("contact"),
      displayName: v.string(),
      role: v.string(),
      type: v.string(),
    }),
  ),
  members: v.array(
    v.strictObject({
      // Workspace member (user) id: a handle save_task assignees accept.
      userId: passthroughId(),
      name: v.string(),
    }),
  ),
});

const LIST_MATTERS_PROJECTION: ChatProjectionSchema = v.union([
  listMattersListProjection,
  listMattersDetailProjection,
]);

/**
 * The `FieldContent` union (`schema-validators.ts`), modeled variant by
 * variant so a new file-plumbing field cannot slip past the strict parse. The
 * file variant's storage/derivative plumbing (file ids, integrity hash,
 * derivative statuses, thumbnail placeholder) is web-UI/file-pipeline
 * machinery chat cannot act on: stripped, which is what keeps the raw
 * `content.id`/`content.pdfFileId` file UUIDs (the second prod backstop trip)
 * out of the model context entirely.
 */
const documentFieldContentProjection: ChatProjectionSchema = v.variant("type", [
  v.strictObject({ version: v.literal(1), type: v.literal("error") }),
  v.strictObject({ version: v.literal(1), type: v.literal("pending") }),
  v.strictObject({ version: v.literal(1), type: v.literal("unsupported") }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("file"),
    id: strippedField(),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    encrypted: v.boolean(),
    sha256Hex: strippedField(),
    pdfFileId: strippedField(),
    pdfDerivative: v.optional(strippedField()),
    thumbnailFileId: v.optional(strippedField()),
    placeholder: v.optional(strippedField()),
    thumbnailDerivative: v.optional(strippedField()),
    scanWarnings: v.optional(v.array(v.string())),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("text"),
    value: v.string(),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("single-select"),
    value: v.nullable(v.string()),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("multi-select"),
    value: v.array(v.string()),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("date"),
    value: v.nullable(v.string()),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("int"),
    value: v.number(),
    currency: v.nullable(v.string()),
  }),
  v.strictObject({
    version: v.literal(1),
    type: v.literal("clip"),
    url: v.string(),
    snippet: v.optional(v.string()),
    citation: v.optional(v.string()),
    jurisdiction: v.optional(v.string()),
    sourceType: v.optional(v.string()),
  }),
]);

/**
 * One field row of a document version, shared by read_document's default and
 * specific-version branches (both select `{ id, propertyId, content }`).
 */
const documentFieldProjection = v.strictObject({
  // Field-row handle, no chat ref kind.
  id: passthroughId(),
  propertyId: chatRef("property"),
  content: documentFieldContentProjection,
});

/** One version-history entry (`loadVersionHistory`, `document-tools.ts`). */
const documentVersionEntryProjection = v.strictObject({
  // Entity-version handle, no chat ref kind.
  id: passthroughId(),
  versionNumber: v.number(),
  stamp: v.nullable(v.string()),
  label: v.nullable(v.string()),
  description: v.nullable(v.string()),
  createdAt: v.string(),
});

// The output entity IS the request's own `entity_id` input in every branch;
// hydration reuses the ref dehydrated on the way in.
const readDocumentEntityId = () =>
  chatEntityRef({ from: "inputEntity", param: "entity_id" });

/**
 * read_document, all three branches (`handleReadDocumentTool`,
 * `document-tools.ts`): default (current version, optionally with version
 * history), specific version, and version diff.
 */
const READ_DOCUMENT_PROJECTION: ChatProjectionSchema = v.union([
  // Default branch: current version metadata + field values, plus the
  // version-history page when `include_versions` was requested.
  v.strictObject({
    entityId: readDocumentEntityId(),
    kind: v.string(),
    name: v.string(),
    fields: v.array(documentFieldProjection),
    versions: v.optional(v.array(documentVersionEntryProjection)),
    // Opaque `[versionNumber, entityVersionId]` cursor, not UUID-formatted.
    versionsNextCursor: v.optional(v.nullable(passthroughId())),
  }),
  // version_id branch: one version's metadata + field values.
  v.strictObject({
    entityId: readDocumentEntityId(),
    name: v.string(),
    version: v.strictObject({
      id: passthroughId(),
      versionNumber: v.number(),
      stamp: v.nullable(v.string()),
      label: v.nullable(v.string()),
      description: v.nullable(v.string()),
      createdAt: v.string(),
      fields: v.array(documentFieldProjection),
    }),
  }),
  // compare_with_version_id branch: plain-text line diff between two versions.
  v.strictObject({
    entityId: readDocumentEntityId(),
    name: v.string(),
    diff: v.strictObject({
      // Entity-version handles, no chat ref kind.
      baseVersionId: passthroughId(),
      targetVersionId: passthroughId(),
      segments: v.array(
        v.variant("kind", [
          v.strictObject({
            kind: v.picklist(["added", "removed", "unchanged", "gap"]),
            text: v.string(),
          }),
          v.strictObject({
            kind: v.literal("changed"),
            runs: v.array(
              v.strictObject({
                kind: v.picklist(["same", "del", "ins"]),
                text: v.string(),
              }),
            ),
          }),
        ]),
      ),
    }),
  }),
]);

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
    stripPaths: [],
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
    stripPaths: [],
  },

  // --- Matters / contacts / content -----------------------------------------
  // Converted: the projection schema above is the single output-side artifact;
  // its strict parse fails closed on any handler field the schema does not
  // declare, and the mediation lists are derived from its annotations.
  list_matters: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: LIST_MATTERS_PROJECTION,
  },
  list_contacts: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [{ kind: "contact", path: "items[].id" }],
    // `nextCursor` is an opaque base64url pagination cursor.
    passthroughIdPaths: ["nextCursor"],
    stripPaths: [],
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
    stripPaths: [],
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
    stripPaths: [],
  },
  read_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    outputRefs: [{ kind: "contact", path: "contactId" }],
    passthroughIdPaths: [],
    stripPaths: [],
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
    stripPaths: [],
  },
  // Converted: see READ_DOCUMENT_PROJECTION above. Beyond reproducing the
  // previous hand lists, the schema strips the file-content plumbing UUIDs
  // (`fields[].content.id`/`.pdfFileId` and the version-branch twins) that
  // the hand entry never declared and that tripped the prod backstop on any
  // document whose field held a file.
  read_document: {
    chatProjectable: true,
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    projection: READ_DOCUMENT_PROJECTION,
  },
  list_properties: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [{ kind: "property", path: "properties[].id" }],
    // Opaque `[createdAt, id]` cursor; not UUID-formatted.
    passthroughIdPaths: ["nextCursor"],
    stripPaths: [],
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
    stripPaths: [],
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
    stripPaths: [],
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
    // Tier rule and fallback-entry ids are client-supplied stable ids inside
    // the positions jsonb, UUID-shaped in practice; no chat tool accepts
    // them, so the projection strips them instead of passing UUID noise
    // through to the model.
    stripPaths: [
      "playbook.positions.items[].tiers.acceptable.rules[].id",
      "playbook.positions.items[].tiers.fallback.entries[].id",
      "playbook.positions.items[].tiers.notAcceptable.rules[].id",
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
        // List mode always has matter_id (schema-enforced), so the input arg is
        // the workspace source.
        workspace: { from: "inputParam", param: "matter_id" },
      },
      {
        kind: "entity",
        path: "entry.entityId",
        // Detail mode may omit matter_id (time_entry_id alone), so recover the
        // workspace from the fetched entry row, which now carries it.
        workspace: { from: "sibling", key: "workspaceId" },
      },
      // The detail entry's own owning workspace is a matter ref.
      { kind: "matter", path: "entry.workspaceId" },
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
    stripPaths: [],
  },
  resolve_rate: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  list_invoices: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    // Detail mode (invoice_id) may omit matter_id, so every line item's entity
    // recovers its workspace from the invoice's own resolved `workspaceId`
    // rather than from the (absent) input arg. List mode returns no line items,
    // so these `invoice.*` paths only ever match the detail branch.
    outputRefs: [
      {
        kind: "entity",
        path: "invoice.timeEntries[].entityId",
        workspace: { from: "outputPath", path: "invoice.workspaceId" },
      },
      {
        kind: "entity",
        path: "invoice.timeEntries[].entity.id",
        workspace: { from: "outputPath", path: "invoice.workspaceId" },
      },
      {
        kind: "entity",
        path: "invoice.expenses[].entityId",
        workspace: { from: "outputPath", path: "invoice.workspaceId" },
      },
      {
        kind: "entity",
        path: "invoice.expenses[].entity.id",
        workspace: { from: "outputPath", path: "invoice.workspaceId" },
      },
      // The detail invoice's own owning workspace is a matter ref.
      { kind: "matter", path: "invoice.workspaceId" },
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
    stripPaths: [],
  },
  get_usage: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Org billing-plan ids, not tenant refs.
    passthroughIdPaths: ["entitlement.id", "policy.id"],
    stripPaths: [],
  },

  // --- Public corpora: public ids, no tenant refs ---------------------------
  search_case_law: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    // Public case-law corpus id; `source_id` is a request input, never an
    // output field, so it needs no output-path declaration here.
    passthroughIdPaths: ["results[].decisionId", "nextCursor"],
    stripPaths: [],
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
    stripPaths: [],
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
    stripPaths: [],
  },
  lookup_business_registry: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
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
    stripPaths: [],
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
    stripPaths: [],
  },

  // --- Capability meta-tools: not projected to chat -------------------------
  // The generic capability surface (list/describe/invoke) is reached over the
  // MCP/CLI transport, never from chat: chat has its own curated tool set and
  // the generic path cannot prove per-capability ref safety. Kept off the chat
  // surface (`chatProjectable: false`); the entries exist only to satisfy the
  // typecheck-forced completeness guard.
  list_capabilities: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  describe_capability: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
} as const satisfies Record<RegistryReadToolName, RegistryRefFieldMapEntry>;

/**
 * Per-tool ref decision for every write tool in the MCP registry. Keyed by the
 * derived `RegistryWriteToolName` union via `satisfies`, so the map is
 * exhaustive by construction: a write tool with no entry here cannot compile,
 * which is the class-guard that stops a future write tool being silently left
 * out of the chat projection.
 *
 * Input-param ref kinds were verified against each tool's actual `inputSchema`
 * in `apps/api/src/mcp/*-tools.ts`; output paths were verified against each
 * handler's `textResult(...)` payload. Params that carry no chat ref kind (task
 * ids, user ids, template/clause/category/playbook ids, time-entry/version/link
 * ids, plain fields) are passed to the handler verbatim and are documented per
 * entry. The four mediated kinds are exactly the ones the chat ref registry
 * mints: matter, entity, contact, property.
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
    // Both the create and update branches return `{ matterId }` (update adds
    // `updated: true`); the matter id is a workspace tenant id.
    outputRefs: [{ kind: "matter", path: "matterId" }],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  delete_matter: {
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    // Returns `{ deleted: true }`: an ack with no id.
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  save_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    // Both branches return `{ contactId }`.
    outputRefs: [{ kind: "contact", path: "contactId" }],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  delete_contact: {
    chatProjectable: true,
    inputRefs: [{ kind: "contact", param: "contact_id" }],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
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
    // Create returns `{ taskId }` (a new entity); update returns
    // `{ taskId, updated: true }` echoing the input task. The task entity's
    // workspace is the resolved `matter_id` (create requires it via
    // `ensureActiveWorkspace`); the update echo is caught first by the
    // dehydrated-entity reuse map, so this source only drives the create case.
    outputRefs: [
      {
        kind: "entity",
        path: "taskId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
    ],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  link_matter_contact: {
    chatProjectable: true,
    // `workspace_contact_id` is the matter-contact join-row handle, not a chat
    // ref, so it passes through as-is.
    inputRefs: [
      { kind: "matter", param: "matter_id" },
      { kind: "contact", param: "contact_id" },
    ],
    // Link returns `{ workspaceContactId }` (a join-row handle); unlink returns
    // `{ unlinked: true }`. The join-row id is a non-tenant handle.
    outputRefs: [],
    passthroughIdPaths: ["workspaceContactId"],
    stripPaths: [],
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
    // Create returns `{ entityId }` (new document); update returns
    // `{ updated: true }`. A created document's workspace is the resolved
    // `matter_id` (create requires it via `ensureActiveWorkspace`).
    outputRefs: [
      {
        kind: "entity",
        path: "entityId",
        workspace: { from: "inputParam", param: "matter_id" },
      },
    ],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  delete_document: {
    chatProjectable: true,
    // `version_id` is an entity-version handle: passes through.
    inputRefs: [{ kind: "entity", param: "entity_id" }],
    // Returns `{ deleted: true }`.
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  set_field_value: {
    chatProjectable: true,
    // The only write tool with a `property` input ref (called out in
    // `ref-mediation.ts`'s dehydration core). `content` is a plain field value.
    inputRefs: [
      { kind: "entity", param: "entity_id" },
      { kind: "property", param: "property_id" },
    ],
    // Returns `{}`.
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
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
    // Both branches return `{ timeEntryId }` (update adds `updated: true`); the
    // time-entry id is a billing handle, not a tenant ref.
    outputRefs: [],
    passthroughIdPaths: ["timeEntryId"],
    stripPaths: [],
  },
  delete_time_entry: {
    chatProjectable: true,
    inputRefs: [],
    // Returns `{ deleted }` (a boolean).
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },

  // --- Knowledge ------------------------------------------------------------
  save_clause: {
    chatProjectable: true,
    // `clause_id` and `category_id` are org-scoped library handles, not chat
    // refs: they pass through as-is.
    inputRefs: [],
    // Both branches return `{ clauseId }` (a library handle).
    outputRefs: [],
    passthroughIdPaths: ["clauseId"],
    stripPaths: [],
  },
  delete_clause: {
    chatProjectable: true,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  run_playbook: {
    chatProjectable: true,
    // `playbook_id` is an org-scoped library handle: passes through.
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    // Returns `{ runPropertyCount }`: an integer, no id.
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },

  // --- Organization ---------------------------------------------------------
  manage_organization: {
    chatProjectable: true,
    // `user_id` is a workspace-member (user) handle, not a chat ref: passes
    // through. `matter_id` is a matter ref (used by the add/remove member
    // actions that scope to a matter).
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    // add_member returns `{ memberId }`, remove_member `{ removed: true, id }`;
    // both are membership-row handles, not tenant refs. update_org_settings
    // returns scalar settings only.
    outputRefs: [],
    passthroughIdPaths: ["memberId", "id"],
    stripPaths: [],
  },

  // --- Practice profile -----------------------------------------------------
  set_practice_jurisdictions: {
    chatProjectable: true,
    inputRefs: [],
    // Returns `{ practiceJurisdictions }`: country codes and booleans, no id.
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },

  // --- Templates ------------------------------------------------------------
  // `fill_template` is already served by the hand-written chat tool in
  // `createTemplateTools` (AI-fillable fields, shared with the REST fill
  // routes), so projecting it from the registry would collide on the tool name.
  // It stays off the registry write projection (`chatProjectable: false`) and
  // is instead classified `mutation` in the chat tool-policy map so the
  // existing tool still asks for approval before filling. The entry is kept for
  // the typecheck-forced completeness guard and its input `template_id` is a
  // template handle (not a chat ref) either way.
  fill_template: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  // Compound template persistence is an MCP/CLI convenience for clients that
  // cannot PUT bytes. Chat already has first-class template/document flows;
  // projecting this would duplicate that surface and its approval UX.
  save_filled_template: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
  save_template: {
    chatProjectable: true,
    // `template_id` is an org template handle, not a chat ref: passes through.
    inputRefs: [],
    // Create returns `{ templateId, name, fieldCount }` (template handle);
    // configure returns the describe shape (name + field configs, no ids).
    outputRefs: [],
    passthroughIdPaths: ["templateId"],
    stripPaths: [],
  },

  // --- Feedback -------------------------------------------------------------
  // `send_feedback` is an agent/MCP tool that reports bugs to the maintainers
  // and runs its own human-approval handshake (preview -> confirmation token).
  // It is not a chat surface tool: it takes no entity references, returns no
  // tenant ids, and would double-gate on approval if projected. It stays off
  // the chat write projection (`chatProjectable: false`, like `fill_template`),
  // so it never enters `ProjectedWriteToolName` or the chat tool-policy map. The
  // entry exists only to satisfy the typecheck-forced completeness guard.
  send_feedback: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },

  // --- Capability meta-tool: not projected to chat --------------------------
  // `invoke_capability` runs an arbitrary catalog capability over the MCP/CLI
  // transport; its authority is enforced per capability inside the handler, and
  // it is never dispatched from chat. Kept off the chat write projection
  // (`chatProjectable: false`, like `fill_template`/`send_feedback`); the entry
  // exists only for the typecheck-forced completeness guard.
  invoke_capability: {
    chatProjectable: false,
    inputRefs: [],
    outputRefs: [],
    passthroughIdPaths: [],
    stripPaths: [],
  },
} as const satisfies Record<RegistryWriteToolName, RegistryRefFieldMapEntry>;
