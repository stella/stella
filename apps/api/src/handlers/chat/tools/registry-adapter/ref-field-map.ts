import * as v from "valibot";

import type { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

import type {
  ChatProjectionSchema,
  RegistryRefKind,
} from "./projection-schema";
import {
  chatEntityRef,
  chatRef,
  passthroughId,
  strippedField,
  unenumeratedJson,
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
 * One directory email/phone as persisted in the contacts jsonb columns
 * (`contactEmailSchema`/`contactPhoneSchema`, `db/schema-validators.ts`):
 * a closed-set `type`, the address/number, an `isPrimary` flag, and an
 * optional free-text label.
 */
const contactEmailProjection = v.strictObject({
  type: v.string(),
  address: v.string(),
  isPrimary: v.boolean(),
  label: v.optional(v.string()),
});

const contactPhoneProjection = v.strictObject({
  type: v.string(),
  number: v.string(),
  isPrimary: v.boolean(),
  label: v.optional(v.string()),
});

/**
 * list_contacts. Source of truth: `listContactsPage`
 * (`handlers/contacts/list-query.ts`), whose whole `Page` envelope
 * (`items`/`limit`/`nextCursor`) is forwarded verbatim by
 * `handleListContactsTool`. The jsonb directory columns
 * (`emails`/`phones`/`tags`) are nullable at the column level.
 */
const LIST_CONTACTS_PROJECTION: ChatProjectionSchema = v.strictObject({
  items: v.array(
    v.strictObject({
      id: chatRef("contact"),
      type: v.string(),
      displayName: v.string(),
      firstName: v.nullable(v.string()),
      lastName: v.nullable(v.string()),
      organizationName: v.nullable(v.string()),
      emails: v.nullable(v.array(contactEmailProjection)),
      phones: v.nullable(v.array(contactPhoneProjection)),
      tags: v.nullable(v.array(v.string())),
      color: v.nullable(v.string()),
      createdAt: v.string(),
      clientMatterCount: v.number(),
    }),
  ),
  limit: v.number(),
  // Opaque `[displayName, id]` cursor; embeds a contact id but is
  // base64url-encoded, not UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * search_across_matters. Source of truth: `handleSearchAcrossMattersTool`
 * (`stella-tools.ts`) mapping the search provider's hits. Hits span multiple
 * matters, so each entity recovers its workspace from the sibling
 * `workspaceId` field.
 */
const SEARCH_ACROSS_MATTERS_PROJECTION: ChatProjectionSchema = v.strictObject({
  totalCount: v.number(),
  // Opaque provider cursor, never UUID-formatted: plain data, not a handle.
  nextCursor: v.nullable(v.string()),
  hits: v.array(
    v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: chatRef("matter"),
      workspaceName: v.string(),
      name: v.string(),
      kind: v.string(),
      headline: v.nullable(v.string()),
    }),
  ),
});

/**
 * read_content_across_matters. Source of truth:
 * `handleReadContentAcrossMattersTool` (`stella-tools.ts`); `nextCursor` is
 * the numeric char-offset window cursor the egress pipeline writes back.
 */
const READ_CONTENT_ACROSS_MATTERS_PROJECTION: ChatProjectionSchema =
  v.strictObject({
    charCount: v.number(),
    // The output entity is the request's own `entity_id` input, so hydration
    // reuses the dehydrated ref; the sibling source (the hand entry's
    // declaration, kept verbatim) only backs a non-echo payload.
    entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
    kind: v.string(),
    name: v.string(),
    text: v.string(),
    truncated: v.boolean(),
    nextCursor: v.nullable(v.string()),
    workspaceId: chatRef("matter"),
  });

/**
 * read_contact. Source of truth: `handleReadContactTool` (`stella-tools.ts`);
 * `emails`/`phones` pass through `arrayOrEmpty`, so they are always arrays.
 */
const READ_CONTACT_PROJECTION: ChatProjectionSchema = v.strictObject({
  contactId: chatRef("contact"),
  type: v.string(),
  displayName: v.string(),
  firstName: v.nullable(v.string()),
  lastName: v.nullable(v.string()),
  organizationName: v.nullable(v.string()),
  emails: v.array(contactEmailProjection),
  phones: v.array(contactPhoneProjection),
});

/**
 * list_documents. Source of truth: `handleListDocumentsTool`
 * (`document-tools.ts`) — the selected entity columns minus the cursor
 * timestamp. `matter_id` is required input, so it is every row's workspace.
 */
const LIST_DOCUMENTS_PROJECTION: ChatProjectionSchema = v.strictObject({
  documents: v.array(
    v.strictObject({
      id: chatEntityRef({ from: "inputParam", param: "matter_id" }),
      name: v.string(),
      kind: v.string(),
      parentId: v.nullable(
        chatEntityRef({ from: "inputParam", param: "matter_id" }),
      ),
    }),
  ),
  // Opaque `[createdAt, id]` cursor; embeds an entity id, not UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

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
 * list_properties. Source of truth: `handleListPropertiesTool`
 * (`document-tools.ts`) — selected property columns mapped to
 * `{ id, name, valueType, status }`.
 */
const LIST_PROPERTIES_PROJECTION: ChatProjectionSchema = v.strictObject({
  properties: v.array(
    v.strictObject({
      id: chatRef("property"),
      name: v.string(),
      valueType: v.string(),
      status: v.string(),
    }),
  ),
  // Opaque `[createdAt, id]` cursor; not UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_tasks, list branch. Source of truth: `handleListTasksTool`
 * (`matter-tools.ts`) — selected entity columns minus the cursor timestamp.
 */
const listTasksListProjection = v.strictObject({
  tasks: v.array(
    v.strictObject({
      id: chatEntityRef({ from: "inputParam", param: "matter_id" }),
      name: v.string(),
      status: v.nullable(v.string()),
      priority: v.nullable(v.string()),
      dueDate: v.nullable(v.string()),
    }),
  ),
  // Opaque `[createdAt, id]` cursor embedding an entity id, not
  // UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_tasks, detail branch: one task's fields, assignees, and entity links
 * (`readTaskDetail` + the mappers in `handleListTasksTool`).
 */
const listTasksDetailProjection = v.strictObject({
  task: v.strictObject({
    taskId: chatEntityRef({ from: "inputEntity", param: "task_id" }),
    name: v.string(),
    status: v.nullable(v.string()),
    priority: v.nullable(v.string()),
    dueDate: v.nullable(v.string()),
    startAt: v.nullable(v.string()),
    endAt: v.nullable(v.string()),
    location: v.nullable(v.string()),
    agendaKind: v.nullable(v.string()),
    assignees: v.array(
      v.strictObject({
        // Workspace-member (user) handle save_task assignee args accept.
        userId: passthroughId(),
        name: v.string(),
        role: v.string(),
      }),
    ),
    links: v.array(
      v.strictObject({
        // Entity-link handle save_task's unlink_link_id accepts.
        linkId: passthroughId(),
        linkType: v.string(),
        direction: v.string(),
        entity: v.strictObject({
          // Entity links are validated same-workspace at creation:
          // `createEntityLinkHandler` (entity-links-create.ts, shared by the
          // HTTP route and save_task) looks up both the source and target
          // entities scoped to one ambient `workspaceId` before inserting
          // the link row, so a linked entity always belongs to the task's
          // own workspace. Detail mode only reaches this path via `task_id`
          // (list mode's `tasks[]` carries no `links`), so the workspace
          // already resolved for that input entity is the correct source.
          id: v.nullable(
            chatEntityRef({ from: "inputEntityWorkspace", param: "task_id" }),
          ),
          name: v.nullable(v.string()),
          kind: v.nullable(v.string()),
        }),
      }),
    ),
  }),
});

const LIST_TASKS_PROJECTION: ChatProjectionSchema = v.union([
  listTasksListProjection,
  listTasksDetailProjection,
]);

/**
 * One clause-body paragraph (`ClauseParagraph`, `lib/clauses/types.ts`): the
 * text plus optional style/list/directive metadata. Org-authored data, no
 * ids.
 */
const clauseParagraphProjection = v.strictObject({
  text: v.string(),
  style: v.optional(v.string()),
  level: v.optional(v.number()),
  runs: v.optional(
    v.array(
      v.strictObject({
        text: v.string(),
        bold: v.optional(v.boolean()),
        italic: v.optional(v.boolean()),
      }),
    ),
  ),
  isDirective: v.optional(v.boolean()),
  directiveKind: v.optional(v.string()),
  directiveExpression: v.optional(v.string()),
  listKind: v.optional(v.string()),
  listLevel: v.optional(v.number()),
});

const clauseBodyProjection: v.GenericSchema = v.array(
  clauseParagraphProjection,
);

/**
 * list_clauses, list branch. Source of truth: `handleListClausesTool`
 * (`knowledge-tools.ts`) forwarding `listClausesHandler` items, plus the
 * optional `listCategoriesHandler` catalog. Clause, category, and
 * clause-version ids are org-scoped library handles, not tenant refs.
 */
const listClausesListProjection = v.strictObject({
  clauses: v.array(
    v.strictObject({
      id: passthroughId(),
      title: v.string(),
      categoryId: v.nullable(passthroughId()),
      language: v.nullable(v.string()),
      description: v.nullable(v.string()),
      currentVersion: v.number(),
      createdAt: v.string(),
      updatedAt: v.string(),
    }),
  ),
  categories: v.optional(
    v.array(
      v.strictObject({
        id: passthroughId(),
        parentId: v.nullable(passthroughId()),
        name: v.string(),
        description: v.nullable(v.string()),
        sortOrder: v.number(),
        createdAt: v.string(),
        updatedAt: v.string(),
      }),
    ),
  ),
  // Opaque `${isoDate}|${clauseId}` cursor.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_clauses, detail branch (`readClauseDetail` + `getClauseHandler`).
 * `metadata` is set to `undefined` at the handler, so it never survives the
 * JSON round-trip; `createdBy` is the authoring user's id (a `text` column,
 * not a uuid column, but licensed defensively in case a deployment's user
 * ids happen to be uuid-shaped).
 */
const listClausesDetailProjection = v.strictObject({
  clause: v.strictObject({
    id: passthroughId(),
    title: v.string(),
    categoryId: v.nullable(passthroughId()),
    description: v.nullable(v.string()),
    usageNotes: v.nullable(v.string()),
    language: v.nullable(v.string()),
    body: clauseBodyProjection,
    currentVersion: v.number(),
    createdBy: passthroughId(),
    createdAt: v.string(),
    updatedAt: v.string(),
    variants: v.array(
      v.strictObject({
        id: passthroughId(),
        label: v.string(),
        body: clauseBodyProjection,
        sortOrder: v.number(),
        createdAt: v.string(),
      }),
    ),
    versions: v.array(
      v.strictObject({
        id: passthroughId(),
        version: v.number(),
        createdAt: v.string(),
      }),
    ),
  }),
});

/** list_clauses, version branch (`getClauseVersionHandler`). */
const listClausesVersionProjection = v.strictObject({
  version: v.strictObject({
    id: passthroughId(),
    version: v.number(),
    body: clauseBodyProjection,
    createdAt: v.string(),
  }),
});

const LIST_CLAUSES_PROJECTION: ChatProjectionSchema = v.union([
  listClausesListProjection,
  listClausesDetailProjection,
  listClausesVersionProjection,
]);

/**
 * The acceptable tier's ideal language (`idealLanguageSchema`,
 * `lib/workflow/playbook-positions.ts`): a clause-library link or inline
 * text. The clause id is the same org-scoped library handle `list_clauses`
 * licenses. The hand-written entry licensed a stale
 * `items[].standard.clauseId` path from the pre-v2 positions shape instead —
 * exactly the silent drift a hand list cannot surface; the derivation test
 * documents the swap.
 */
const playbookIdealLanguageProjection: ChatProjectionSchema = v.variant(
  "source",
  [
    v.strictObject({
      source: v.literal("clause"),
      clauseId: passthroughId(),
      clauseVersion: v.optional(v.number()),
    }),
    v.strictObject({ source: v.literal("inline"), text: v.string() }),
  ],
);

/**
 * The Acceptable / Fallback / Not acceptable ladder (`tiersSchema`). Tier
 * rule and fallback-entry ids are client-supplied stable ids inside the
 * positions jsonb, UUID-shaped in practice; no chat tool accepts them, so
 * the projection strips them instead of passing UUID noise to the model.
 */
const playbookTiersProjection = v.strictObject({
  acceptable: v.strictObject({
    rules: v.array(v.strictObject({ id: strippedField(), text: v.string() })),
    ideal: v.optional(playbookIdealLanguageProjection),
  }),
  fallback: v.strictObject({
    entries: v.array(
      v.strictObject({
        id: strippedField(),
        text: v.string(),
        label: v.optional(v.string()),
      }),
    ),
  }),
  notAcceptable: v.strictObject({
    rules: v.array(v.strictObject({ id: strippedField(), text: v.string() })),
  }),
});

// `content` is a `PropertyContent` config (a structural type descriptor with
// no stable leaf grammar across its variants): an unenumerated subtree, so
// the UUID backstop still guards its contents unlicensed.
const playbookAskManualProjection = v.strictObject({
  question: v.string(),
  content: unenumeratedJson(),
});

const playbookAskConfigProjection: ChatProjectionSchema = v.variant("mode", [
  v.strictObject({
    mode: v.literal("auto"),
    derived: v.optional(
      v.strictObject({
        question: v.string(),
        content: unenumeratedJson(),
        rulesHash: v.string(),
      }),
    ),
  }),
  v.strictObject({
    mode: v.literal("manual"),
    question: v.string(),
    content: unenumeratedJson(),
  }),
]);

/**
 * One playbook position (`positionSchema`): the `extract` and `graded`
 * variants. `check` carries a recursive condition AST (`tConditionNode`):
 * unenumerated, so the backstop still guards it.
 */
const playbookPositionProjection: ChatProjectionSchema = v.variant("mode", [
  v.strictObject({
    mode: v.literal("extract"),
    // Client-supplied stable id that maps a position back to its
    // materialized column across edits; run_playbook accepts none of these,
    // but the id survives as a documented handle rather than UUID noise the
    // strict parse would refuse.
    sourceId: passthroughId(),
    issue: v.string(),
    ask: playbookAskManualProjection,
    guidance: v.optional(v.string()),
    enabled: v.boolean(),
  }),
  v.strictObject({
    mode: v.literal("graded"),
    sourceId: passthroughId(),
    issue: v.string(),
    severity: v.string(),
    tiers: playbookTiersProjection,
    check: v.optional(unenumeratedJson()),
    ask: playbookAskConfigProjection,
    guidance: v.optional(v.string()),
    negotiation: v.optional(
      v.strictObject({
        rationale: v.optional(v.string()),
        talkingPoints: v.optional(v.array(v.string())),
        escalation: v.optional(v.string()),
      }),
    ),
    enabled: v.boolean(),
  }),
]);

/**
 * list_playbooks, list branch. Source of truth:
 * `listPlaybookDefinitionsHandler` (`handlers/playbooks/read.ts`), forwarded
 * verbatim as `{ items, nextCursor }`.
 */
const listPlaybooksListProjection = v.strictObject({
  items: v.array(
    v.strictObject({
      id: passthroughId(),
      name: v.string(),
      description: v.nullable(v.string()),
      status: v.string(),
      createdAt: v.string(),
      updatedAt: v.string(),
    }),
  ),
  // Opaque `[playbookId]` cursor, base64url-encoded.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_playbooks, detail branch (`getPlaybookDefinitionHandler`): the full
 * definition including the versioned positions jsonb.
 */
const listPlaybooksDetailProjection = v.strictObject({
  playbook: v.strictObject({
    id: passthroughId(),
    name: v.string(),
    description: v.nullable(v.string()),
    scope: v.nullable(
      v.strictObject({
        documentTypeKey: v.optional(v.string()),
        perspective: v.optional(v.string()),
        trigger: v.optional(v.string()),
      }),
    ),
    positions: v.strictObject({
      version: v.literal(2),
      items: v.array(playbookPositionProjection),
    }),
    status: v.string(),
    approvedAt: v.nullable(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }),
});

const LIST_PLAYBOOKS_PROJECTION: ChatProjectionSchema = v.union([
  listPlaybooksListProjection,
  listPlaybooksDetailProjection,
]);

/**
 * The time-entry columns both list_time_entries branches select
 * (`timeEntryColumns`, `billing-tools.ts`), plus the `userName` the handler
 * resolves. `entityId` is the entry's matter entity; `id`/`userId` are
 * billing/user handles, not tenant refs.
 */
const timeEntryFieldEntries = (workspace: { from: "inputParam" | "sibling" }) =>
  ({
    id: passthroughId(),
    entityId: chatEntityRef(
      workspace.from === "inputParam"
        ? { from: "inputParam", param: "matter_id" }
        : { from: "sibling", key: "workspaceId" },
    ),
    userId: v.nullable(passthroughId()),
    dateWorked: v.string(),
    durationMinutes: v.number(),
    billedMinutes: v.number(),
    rateAtEntry: v.number(),
    currency: v.string(),
    narrative: v.string(),
    invoiceNarrative: v.nullable(v.string()),
    billable: v.boolean(),
    noCharge: v.boolean(),
    status: v.string(),
    userName: v.nullable(v.string()),
  }) as const;

const LIST_TIME_ENTRIES_PROJECTION: ChatProjectionSchema = v.union([
  // List mode: matter_id is schema-required, so it is every row's workspace.
  v.strictObject({
    entries: v.array(
      v.strictObject(timeEntryFieldEntries({ from: "inputParam" })),
    ),
    // Opaque `[dateWorked, id]` cursor, not UUID-formatted.
    nextCursor: v.nullable(passthroughId()),
  }),
  // Detail mode may be reached by time_entry_id alone, so the entry carries
  // its resolved owning workspace: a matter ref, and the entity's workspace
  // source.
  v.strictObject({
    entry: v.strictObject({
      ...timeEntryFieldEntries({ from: "sibling" }),
      workspaceId: chatRef("matter"),
    }),
  }),
]);

/**
 * resolve_rate. Source of truth: `handleResolveRateTool` (`billing-tools.ts`)
 * — a rate amount in minor units and a currency code, or nulls when no rate
 * table matches.
 */
const RESOLVE_RATE_PROJECTION: ChatProjectionSchema = v.strictObject({
  hourlyRate: v.nullable(v.number()),
  currency: v.nullable(v.string()),
});

/** One invoiced line item's matter entity card (`{ id, name }`). */
const invoiceLineEntityProjection = () =>
  v.strictObject({
    id: chatEntityRef({ from: "outputPath", path: "invoice.workspaceId" }),
    name: v.string(),
  });

/**
 * list_invoices. Source of truth: `handleListInvoicesTool`
 * (`billing-tools.ts`). Detail mode (invoice_id) may omit matter_id, so every
 * line item's entity recovers its workspace from the invoice's own resolved
 * `workspaceId` rather than from the (absent) input arg; list mode returns no
 * line items.
 */
const LIST_INVOICES_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({
    invoices: v.array(
      v.strictObject({
        id: passthroughId(),
        invoiceNumber: v.string(),
        reference: v.nullable(v.string()),
        status: v.string(),
        invoiceDate: v.string(),
        dueDate: v.nullable(v.string()),
        currency: v.string(),
        totalAmount: v.number(),
      }),
    ),
    // Opaque `[createdAt, id]` cursor, not UUID-formatted.
    nextCursor: v.nullable(passthroughId()),
  }),
  v.strictObject({
    invoice: v.strictObject({
      id: passthroughId(),
      // The detail invoice's own owning workspace is a matter ref.
      workspaceId: chatRef("matter"),
      invoiceNumber: v.string(),
      reference: v.nullable(v.string()),
      status: v.string(),
      invoiceDate: v.string(),
      dueDate: v.nullable(v.string()),
      currency: v.string(),
      totalAmount: v.number(),
      notes: v.nullable(v.string()),
      paidAt: v.nullable(v.string()),
      createdAt: v.string(),
      updatedAt: v.string(),
      timeEntries: v.array(
        v.strictObject({
          id: passthroughId(),
          entityId: chatEntityRef({
            from: "outputPath",
            path: "invoice.workspaceId",
          }),
          dateWorked: v.string(),
          billedMinutes: v.number(),
          rateAtEntry: v.number(),
          currency: v.string(),
          narrative: v.string(),
          invoiceNarrative: v.nullable(v.string()),
          status: v.string(),
          entity: invoiceLineEntityProjection(),
        }),
      ),
      expenses: v.array(
        v.strictObject({
          id: passthroughId(),
          entityId: chatEntityRef({
            from: "outputPath",
            path: "invoice.workspaceId",
          }),
          dateIncurred: v.string(),
          amount: v.number(),
          currency: v.string(),
          category: v.string(),
          description: v.string(),
          invoiceDescription: v.nullable(v.string()),
          billable: v.boolean(),
          markup: v.number(),
          entity: invoiceLineEntityProjection(),
        }),
      ),
    }),
  }),
]);

/**
 * get_usage. Source of truth: `readOrgEntitlementHandler`
 * (`handlers/usage/get-entitlement.ts`): `{ entitlement: null }` when the
 * organization has no active plan, otherwise the plan/seat/period shape.
 * Entitlement and policy ids are org billing-plan handles, not tenant refs.
 */
const GET_USAGE_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({ entitlement: v.null() }),
  v.strictObject({
    entitlement: v.strictObject({
      id: passthroughId(),
      status: v.string(),
      seats: v.number(),
      source: v.string(),
      currentPeriodStart: v.string(),
      currentPeriodEnd: v.string(),
      cancelAtPeriodEnd: v.boolean(),
    }),
    policy: v.strictObject({
      id: passthroughId(),
      key: v.string(),
      displayName: v.string(),
      monthlyUsageUnitsPerSeat: v.number(),
    }),
    remainingUsageUnits: v.number(),
  }),
]);

/** One facet bucket of the case-law search response. */
const caseLawFacetBucketProjection = v.strictObject({
  value: v.string(),
  count: v.number(),
});

/**
 * search_case_law. Source of truth: `handleSearchCaseLawTool`
 * (`stella-tools.ts`) mapping `searchDecisionsHandler` hits; `facets` and
 * `totalCount` are null on cursor pages. Decision ids are public case-law
 * corpus ids, not tenant refs.
 */
const SEARCH_CASE_LAW_PROJECTION: ChatProjectionSchema = v.strictObject({
  facets: v.nullable(
    v.strictObject({
      court: v.array(caseLawFacetBucketProjection),
      country: v.array(caseLawFacetBucketProjection),
      language: v.array(caseLawFacetBucketProjection),
    }),
  ),
  // Opaque `[score, decisionId]` cursor, base64url-encoded.
  nextCursor: v.nullable(passthroughId()),
  results: v.array(
    v.strictObject({
      appUrl: v.string(),
      caseNumber: v.string(),
      citationCount: v.number(),
      country: v.string(),
      court: v.string(),
      decisionDate: v.nullable(v.string()),
      decisionId: passthroughId(),
      decisionType: v.nullable(v.string()),
      ecli: v.nullable(v.string()),
      language: v.string(),
      snippet: v.nullable(v.string()),
      sourceUrl: v.nullable(v.string()),
    }),
  ),
  totalCount: v.nullable(v.number()),
});

/**
 * read_case_law_decision. Source of truth: `handleReadCaseLawDecisionTool`
 * (`stella-tools.ts`) mapping `readDecisionWithDocumentHandler`. All ids are
 * public case-law corpus ids (decision, citation, source). `metadata` is
 * free-form public jsonb straight from the court source and cannot be
 * enumerated by path (same unenumerable-payload caveat as `list_audit_log`'s
 * `metadata`/`changes`, just over public rather than tenant data): declared
 * as an unenumerated subtree the walker skips, so the strict parse admits it
 * while the UUID backstop still guards every string inside, unlicensed.
 */
const READ_CASE_LAW_DECISION_PROJECTION: ChatProjectionSchema = v.strictObject({
  // Opaque compound `[textOffset, fromOffset, toOffset]` cursor.
  nextCursor: v.nullable(passthroughId()),
  decision: v.strictObject({
    appUrl: v.string(),
    caseNumber: v.string(),
    citationsFrom: v.array(
      v.strictObject({
        id: passthroughId(),
        citationText: v.string(),
        citedDecisionId: v.nullable(passthroughId()),
        sectionIndex: v.nullable(v.number()),
      }),
    ),
    citationsFromTotal: v.number(),
    citationsTo: v.array(
      v.strictObject({
        id: passthroughId(),
        citationText: v.string(),
        citingDecisionId: passthroughId(),
        sectionIndex: v.nullable(v.number()),
      }),
    ),
    citationsToTotal: v.number(),
    country: v.string(),
    court: v.string(),
    decisionDate: v.nullable(v.string()),
    decisionId: passthroughId(),
    decisionType: v.nullable(v.string()),
    documentUrl: v.nullable(v.string()),
    ecli: v.nullable(v.string()),
    language: v.string(),
    metadata: unenumeratedJson(),
    source: v.strictObject({
      id: passthroughId(),
      name: v.string(),
      adapterKey: v.string(),
      allowsDerivedAi: v.boolean(),
    }),
    sourceUrl: v.nullable(v.string()),
    text: v.nullable(v.string()),
    charCount: v.nullable(v.number()),
    truncated: v.boolean(),
    textWithheldReason: v.optional(v.string()),
  }),
});

/**
 * search_legislation, all four branches (`handleSearchLegislationTool`,
 * `research-admin-tools.ts`). Public BOE statutory data throughout; the BOE
 * envelopes (`metadata`/`analysis`/`structure`) are deliberately `unknown` in
 * `@stll/boe` (undocumented upstream schema), so they project as
 * unenumerated subtrees the backstop still guards. Ids are BOE identifiers
 * (`BOE-A-…`), never UUID-formatted in practice (`lawId` is schema-validated
 * against the BOE id pattern; `blockId` and `data[].identificador` are
 * licensed defensively since `blockId` is an unvalidated request-argument
 * echo).
 */
const SEARCH_LEGISLATION_PROJECTION: ChatProjectionSchema = v.union([
  // block branch: one article/disposition as raw XML.
  v.strictObject({
    lawId: passthroughId(),
    blockId: passthroughId(),
    block: v.string(),
  }),
  // related branch: `findRelatedLaws` (`@stll/boe`).
  v.strictObject({
    lawId: passthroughId(),
    relationType: v.string(),
    analysis: unenumeratedJson(),
  }),
  // default read branch: `{ law, structure }` (`getConsolidatedLaw` +
  // `getLawStructure`).
  v.strictObject({
    law: v.strictObject({
      lawId: passthroughId(),
      metadata: unenumeratedJson(),
      analysis: unenumeratedJson(),
      fullText: v.nullable(v.string()),
      eli: v.nullable(v.string()),
    }),
    structure: unenumeratedJson(),
  }),
  // search branch: the raw `BoeSearchResponse` envelope (every field
  // optional upstream).
  v.strictObject({
    data: v.optional(
      v.array(
        v.strictObject({
          identificador: passthroughId(),
          titulo: v.optional(v.string()),
          fecha_publicacion: v.optional(v.string()),
          fecha_disposicion: v.optional(v.string()),
          departamento: v.optional(
            v.strictObject({
              codigo: v.optional(v.string()),
              texto: v.optional(v.string()),
            }),
          ),
          rango: v.optional(
            v.strictObject({
              codigo: v.optional(v.string()),
              texto: v.optional(v.string()),
            }),
          ),
          estado_consolidacion: v.optional(
            v.strictObject({
              codigo: v.optional(v.string()),
              texto: v.optional(v.string()),
            }),
          ),
          url_eli: v.optional(v.string()),
          url_html_consolidada: v.optional(v.string()),
        }),
      ),
    ),
    status: v.optional(
      v.strictObject({
        code: v.optional(v.string()),
        text: v.optional(v.string()),
      }),
    ),
  }),
]);

/**
 * One cross-registry hit (`BusinessRegistryHit`,
 * `lib/business-registries/dispatch.ts`). `id` is the external registry's
 * own identifier (company/registration number), plain public data — not a
 * UUID handle, so it needs no license. `details` is the adapter-specific
 * upstream payload (a different typed shape per registry): an unenumerated
 * subtree the backstop still guards.
 */
const businessRegistryHitProjection = v.strictObject({
  registry: v.string(),
  id: v.string(),
  name: v.string(),
  legalForm: v.nullable(v.string()),
  address: v.nullable(
    v.strictObject({
      line1: v.nullable(v.string()),
      line2: v.nullable(v.string()),
      postalCode: v.nullable(v.string()),
      city: v.nullable(v.string()),
      region: v.nullable(v.string()),
      country: v.nullable(v.string()),
      textAddress: v.nullable(v.string()),
    }),
  ),
  registryUrl: v.string(),
  details: v.optional(unenumeratedJson()),
});

/**
 * lookup_business_registry. Source of truth: `executeRegistryLookup`'s
 * `RegistryLookupResponse` union, forwarded verbatim by
 * `handleLookupBusinessRegistryTool` (`matter-tools.ts`).
 */
const LOOKUP_BUSINESS_REGISTRY_PROJECTION: ChatProjectionSchema = v.variant(
  "type",
  [
    v.strictObject({
      type: v.literal("lookup"),
      registry: v.string(),
      hit: v.nullable(businessRegistryHitProjection),
    }),
    v.strictObject({
      type: v.literal("search"),
      registry: v.string(),
      hits: v.array(businessRegistryHitProjection),
    }),
  ],
);

/**
 * The describe shape (`DescribeTemplateResult` success variant,
 * `lib/templates/template-fill-service.ts`) served by list_templates' detail
 * mode and echoed by save_template's configure branch. Field paths, input
 * types, options, and condition/formula expressions are structural
 * org-authored data; no ids anywhere.
 */
const templateDescribeProjection = v.strictObject({
  name: v.string(),
  fields: v.array(
    v.strictObject({
      path: v.string(),
      label: v.nullable(v.string()),
      inputType: v.string(),
      required: v.boolean(),
      hint: v.nullable(v.string()),
      options: v.nullable(v.array(v.string())),
      formats: v.nullable(
        v.array(v.strictObject({ key: v.string(), template: v.string() })),
      ),
      aiPrompt: v.nullable(v.string()),
      aiAdapt: v.boolean(),
      optionsFrom: v.nullable(v.string()),
      dateFormat: v.nullable(
        v.strictObject({ locale: v.string(), style: v.string() }),
      ),
      parts: v.nullable(
        v.array(
          v.strictObject({
            key: v.string(),
            label: v.optional(v.string()),
            inputType: v.string(),
            options: v.optional(v.array(v.string())),
            pattern: v.optional(v.string()),
          }),
        ),
      ),
      format: v.nullable(v.string()),
    }),
  ),
  conditions: v.array(
    v.strictObject({ name: v.string(), expression: v.string() }),
  ),
  computed: v.array(
    v.strictObject({ name: v.string(), expression: v.string() }),
  ),
});

/**
 * list_templates. Source of truth: `handleListTemplatesTool` +
 * `describeTemplateDetail` (`template-tools.ts`). Template ids are org
 * template handles; detail mode's describe payload carries no id fields at
 * all.
 */
const LIST_TEMPLATES_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({
    templates: v.array(
      v.strictObject({
        id: passthroughId(),
        name: v.string(),
        fieldCount: v.number(),
        tags: v.nullable(v.array(v.string())),
        whenToUse: v.nullable(v.string()),
        whenNotToUse: v.nullable(v.string()),
      }),
    ),
    // Opaque `[templateId]` cursor, base64url-encoded.
    nextCursor: v.nullable(passthroughId()),
  }),
  templateDescribeProjection,
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
    chatProjectable: true,
    inputRefs: [{ kind: "matter", param: "matter_id" }],
    projection: RESOLVE_RATE_PROJECTION,
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

// --- Write-tool projections ---------------------------------------------------
// Write payloads are small acks and ids; each schema below mirrors the
// handler's `textResult(...)` construction branch by branch. Input-param ref
// kinds were verified against each tool's actual `inputSchema` in
// `apps/api/src/mcp/*-tools.ts`. Params that carry no chat ref kind (task
// ids, user ids, template/clause/category/playbook ids, time-entry/version/
// link ids, plain fields) are passed to the handler verbatim and are
// documented per entry. The four mediated kinds are exactly the ones the chat
// ref registry mints: matter, entity, contact, property.

/** save_matter: create returns `{ matterId }`; update adds `updated: true`. */
const SAVE_MATTER_PROJECTION: ChatProjectionSchema = v.strictObject({
  matterId: chatRef("matter"),
  updated: v.optional(v.literal(true)),
});

const DELETED_TRUE_PROJECTION: ChatProjectionSchema = v.strictObject({
  deleted: v.literal(true),
});

/** save_contact: both branches return `{ contactId }`. */
const SAVE_CONTACT_PROJECTION: ChatProjectionSchema = v.strictObject({
  contactId: chatRef("contact"),
});

/**
 * save_task: create returns `{ taskId }` (a new entity whose workspace is the
 * resolved `matter_id`, required on create via `ensureActiveWorkspace`);
 * update returns `{ taskId, updated: true }` echoing the input task, which
 * hydration catches first via the dehydrated-entity reuse map, so the
 * `inputParam` source only drives the create case.
 */
const SAVE_TASK_PROJECTION: ChatProjectionSchema = v.strictObject({
  taskId: chatEntityRef({ from: "inputParam", param: "matter_id" }),
  updated: v.optional(v.literal(true)),
});

/**
 * link_matter_contact: link returns `{ workspaceContactId }` (a join-row
 * handle, not a tenant ref); unlink returns `{ unlinked: true }`.
 */
const LINK_MATTER_CONTACT_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({ workspaceContactId: passthroughId() }),
  v.strictObject({ unlinked: v.literal(true) }),
]);

/**
 * save_document: create returns `{ entityId }` (a new document whose
 * workspace is the resolved `matter_id`, required on create); update returns
 * `{ updated: true }`.
 */
const SAVE_DOCUMENT_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({
    entityId: chatEntityRef({ from: "inputParam", param: "matter_id" }),
  }),
  v.strictObject({ updated: v.literal(true) }),
]);

/** set_field_value returns `{}`. */
const SET_FIELD_VALUE_PROJECTION: ChatProjectionSchema = v.strictObject({});

/**
 * save_time_entry: both branches return `{ timeEntryId }` (update adds
 * `updated: true`); the time-entry id is a billing handle, not a tenant ref.
 */
const SAVE_TIME_ENTRY_PROJECTION: ChatProjectionSchema = v.strictObject({
  timeEntryId: passthroughId(),
  updated: v.optional(v.literal(true)),
});

/** delete_time_entry returns `{ deleted }` (a boolean from the handler). */
const DELETE_TIME_ENTRY_PROJECTION: ChatProjectionSchema = v.strictObject({
  deleted: v.boolean(),
});

/** save_clause: both branches return `{ clauseId }` (a library handle). */
const SAVE_CLAUSE_PROJECTION: ChatProjectionSchema = v.strictObject({
  clauseId: passthroughId(),
});

/** run_playbook returns `{ runPropertyCount }`: an integer, no id. */
const RUN_PLAYBOOK_PROJECTION: ChatProjectionSchema = v.strictObject({
  runPropertyCount: v.number(),
});

/**
 * manage_organization: add_member returns `{ memberId }`, remove_member
 * `{ removed: true, id }` (both membership-row handles, not tenant refs);
 * update_org_settings echoes only the scalar settings it changed.
 */
const MANAGE_ORGANIZATION_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({ memberId: passthroughId() }),
  v.strictObject({ removed: v.literal(true), id: passthroughId() }),
  v.strictObject({
    matterNumberPattern: v.optional(v.string()),
    matterNumberPadding: v.optional(v.number()),
    promptCachingEnabled: v.optional(v.boolean()),
    documentProcessingMode: v.optional(v.string()),
  }),
]);

/**
 * set_practice_jurisdictions returns `{ practiceJurisdictions }`: country
 * codes and booleans, no id.
 */
const SET_PRACTICE_JURISDICTIONS_PROJECTION: ChatProjectionSchema =
  v.strictObject({
    practiceJurisdictions: v.array(
      v.strictObject({ countryCode: v.string(), isPrimary: v.boolean() }),
    ),
  });

/**
 * save_template: create returns `{ templateId, name, fieldCount }` (template
 * handle); configure echoes the same describe shape list_templates' detail
 * mode serves, so the agent sees exactly what is now configured.
 */
const SAVE_TEMPLATE_PROJECTION: ChatProjectionSchema = v.union([
  v.strictObject({
    templateId: passthroughId(),
    name: v.string(),
    fieldCount: v.number(),
  }),
  templateDescribeProjection,
]);

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
  delete_document: {
    chatProjectable: true,
    // `version_id` is an entity-version handle: passes through.
    inputRefs: [{ kind: "entity", param: "entity_id" }],
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
