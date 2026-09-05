import * as v from "valibot";

import { ENTITY_KINDS } from "@stll/api-contract";

import { TIME_ENTRY_VISIBILITY } from "@/api/lib/billing-constants";
import {
  DOCUMENT_PROCESSING_FAILURE_CODE,
  DOCUMENT_PROCESSING_KIND,
  DOCUMENT_PROCESSING_REQUIRED_STATUS,
} from "@/api/lib/document-processing-contract";

import {
  chatEntityRef,
  chatRef,
  passthroughId,
  projectionBranch,
  strippedField,
  unenumeratedJson,
} from "./projection-schema";

/**
 * Per-tool chat projection schemas, one artifact per projected registry tool.
 * Split out of `ref-field-map.ts` so the MCP handler modules can import their
 * own projection (to `satisfies`-tie their payload literals against
 * `v.InferInput`) without a cycle: `ref-field-map.ts` derives its key unions
 * from `static-tool-definitions`, which imports every `mcp/*-tools.ts` module,
 * so a handler importing the map would close a loop. This module must import
 * nothing from `@/api/mcp/*` or other handler slices — only the annotation
 * vocabulary from `./projection-schema`.
 *
 * Lives in `lib/` rather than the chat handler slice for the same reason the
 * importers are handlers: handlers -> lib is the only correct direction. Were
 * these schemas to stay under `handlers/chat/`, every MCP tool module and the
 * shared MCP core would depend on the chat slice, and `lib-to-handler-imports`
 * is a ratcheted metric.
 *
 * The constants deliberately carry their precise inferred builder types (no
 * `ChatProjectionSchema` widening): the handlers' compile-time ties need
 * `v.InferInput` over the real entries. `ref-field-map.ts` still widens at its
 * `RefMediationEntry.projection` boundary, so the map's surface is unchanged.
 */

// --- Compile-time payload ties -------------------------------------------------

/**
 * The field paths in `Payload` that `SchemaInput` does not declare, at any
 * depth (arrays compared element-wise; a `Payload` union branch is compared
 * only against the `SchemaInput` branches it is assignable to; an `unknown`
 * schema field — stripped/unenumerated positions — admits any payload type
 * without descending).
 */
type ProjectionScalar =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

type ExtraProjectionFields<Payload, SchemaInput> = unknown extends SchemaInput
  ? never
  : SchemaInput extends ProjectionScalar
    ? never
    : Payload extends readonly (infer Item)[]
      ? SchemaInput extends readonly (infer ShapeItem)[]
        ? ExtraProjectionFields<Item, ShapeItem>
        : never
      : Payload extends object
        ? SchemaInput extends object
          ? Payload extends SchemaInput
            ? {
                [K in keyof Payload]-?: K extends keyof SchemaInput
                  ? ExtraProjectionFields<Payload[K], SchemaInput[K]>
                  : K;
              }[keyof Payload]
            : never
          : never
        : never;

/**
 * Compile-time exactness tie for a chat payload that is NOT built as an
 * object literal (a shared helper's return value forwarded verbatim), where
 * `satisfies v.InferInput<typeof X_PROJECTION>` gets no excess-property
 * check. `AssertNoExtraFields<Payload, SchemaInput>` fails typecheck when
 * `Payload` carries a field the projection schema does not classify, naming
 * the offending keys. Literal construction sites should prefer a direct
 * `satisfies` tie instead.
 */
export type AssertNoExtraFields<
  Payload extends ([ExtraProjectionFields<Payload, SchemaInput>] extends [never]
    ? SchemaInput
    : { unclassifiedFields: ExtraProjectionFields<Payload, SchemaInput> }),
  SchemaInput,
> = Payload;

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
export const LIST_MATTERS_LIST_PROJECTION = v.strictObject({
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
export const LIST_MATTERS_DETAIL_PROJECTION = v.strictObject({
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
        listItemType: v.nullable(v.string()),
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

export const LIST_MATTERS_PROJECTION = v.union([
  projectionBranch(LIST_MATTERS_LIST_PROJECTION),
  projectionBranch(LIST_MATTERS_DETAIL_PROJECTION),
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
 * (`handlers/contacts/list-query.ts`), whose `Page` envelope
 * (`items`/`limit`/`nextCursor`) is projected by `handleListContactsTool`.
 * The handler converts database timestamps to ISO strings at that boundary.
 * The jsonb directory columns
 * (`emails`/`phones`/`tags`) are nullable at the column level.
 */
export const LIST_CONTACTS_PROJECTION = v.strictObject({
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
export const SEARCH_ACROSS_MATTERS_PROJECTION = v.strictObject({
  totalCount: v.number(),
  // Opaque provider cursor, never UUID-formatted: plain data, not a handle.
  nextCursor: v.nullable(v.string()),
  hits: v.array(
    v.strictObject({
      entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
      workspaceId: chatRef("matter"),
      workspaceName: v.string(),
      name: v.string(),
      kind: v.picklist(ENTITY_KINDS),
      headline: v.nullable(v.string()),
    }),
  ),
});

/**
 * read_content_across_matters. Source of truth:
 * `handleReadContentAcrossMattersTool` (`stella-tools.ts`); `nextCursor` is
 * the numeric char-offset window cursor the egress pipeline writes back.
 */
export const READ_CONTENT_ACROSS_MATTERS_PROJECTION = v.strictObject({
  charCount: v.number(),
  // The output entity is the request's own `entity_id` input, so hydration
  // reuses the dehydrated ref; the sibling source (the hand entry's
  // declaration, kept verbatim) only backs a non-echo payload.
  entityId: chatEntityRef({ from: "sibling", key: "workspaceId" }),
  kind: v.picklist(ENTITY_KINDS),
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
export const READ_CONTACT_PROJECTION = v.strictObject({
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
export const LIST_DOCUMENTS_PROJECTION = v.strictObject({
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
const documentFieldContentProjection = v.variant("type", [
  projectionBranch(
    v.strictObject({ version: v.literal(1), type: v.literal("error") }),
  ),
  projectionBranch(
    v.strictObject({ version: v.literal(1), type: v.literal("pending") }),
  ),
  projectionBranch(
    v.strictObject({ version: v.literal(1), type: v.literal("unsupported") }),
  ),
  projectionBranch(
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
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("text"),
      value: v.string(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("single-select"),
      value: v.nullable(v.string()),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("multi-select"),
      value: v.array(v.string()),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("date"),
      value: v.nullable(v.string()),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("int"),
      value: v.number(),
      currency: v.nullable(v.string()),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("money"),
      amountCents: v.number(),
      currency: v.string(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("person"),
      // The workspace member handle is machinery chat cannot act on; the name
      // is what a model reads.
      userId: strippedField(),
      name: v.string(),
      image: strippedField(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      version: v.literal(1),
      type: v.literal("clip"),
      url: v.string(),
      snippet: v.optional(v.string()),
      citation: v.optional(v.string()),
      jurisdiction: v.optional(v.string()),
      sourceType: v.optional(v.string()),
    }),
  ),
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

const documentProcessingRemediationProjection = v.variant("type", [
  projectionBranch(
    v.strictObject({
      type: v.literal("action"),
      tool: v.literal("invoke_capability"),
      // Internal chat cannot invoke generic capabilities. Strip arguments
      // defensively if this unreachable branch is ever returned.
      arguments: strippedField(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      type: v.literal("escalation"),
      requiredScope: v.literal("stella:matters_write"),
      requiredPermission: v.literal("entity:update"),
      instruction: v.string(),
    }),
  ),
]);

const documentContentStateProjection = v.variant("status", [
  projectionBranch(v.strictObject({ status: v.literal("not_applicable") })),
  projectionBranch(
    v.strictObject({
      status: v.literal("ready"),
      source: v.picklist(["direct_docx", "extracted_text"]),
      sourceVersionId: passthroughId(),
      updatedAt: v.string(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("pending"),
      processingKind: v.literal(DOCUMENT_PROCESSING_KIND),
      runId: v.nullable(passthroughId()),
      sourceVersionId: passthroughId(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal(DOCUMENT_PROCESSING_REQUIRED_STATUS),
      sourceVersionId: passthroughId(),
      remediation: documentProcessingRemediationProjection,
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("failed"),
      processingKind: v.literal(DOCUMENT_PROCESSING_KIND),
      runId: passthroughId(),
      sourceVersionId: passthroughId(),
      errorCode: v.literal(DOCUMENT_PROCESSING_FAILURE_CODE),
      retryable: v.literal(true),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("unsupported"),
      sourceVersionId: passthroughId(),
      reason: v.string(),
    }),
  ),
]);

const documentSearchIndexStateProjection = v.variant("status", [
  projectionBranch(v.strictObject({ status: v.literal("not_applicable") })),
  projectionBranch(
    v.strictObject({
      status: v.literal("ready"),
      sourceVersionId: passthroughId(),
      updatedAt: v.string(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("pending"),
      sourceVersionId: passthroughId(),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("failed"),
      runId: passthroughId(),
      sourceVersionId: passthroughId(),
      errorCode: v.literal("search_index_failed"),
      retryable: v.literal(true),
    }),
  ),
  projectionBranch(
    v.strictObject({
      status: v.literal("unsupported"),
      sourceVersionId: passthroughId(),
      reason: v.string(),
    }),
  ),
]);

/**
 * read_document, default branch: current version metadata + field values,
 * plus the version-history page when `include_versions` was requested.
 */
export const READ_DOCUMENT_DEFAULT_PROJECTION = v.strictObject({
  entityId: readDocumentEntityId(),
  kind: v.string(),
  name: v.string(),
  fields: v.array(documentFieldProjection),
  contentState: documentContentStateProjection,
  searchIndexState: documentSearchIndexStateProjection,
  versions: v.optional(v.array(documentVersionEntryProjection)),
  // Opaque `[versionNumber, entityVersionId]` cursor, not UUID-formatted.
  versionsNextCursor: v.optional(v.nullable(passthroughId())),
});

/** read_document, `version_id` branch: one version's metadata + fields. */
export const READ_DOCUMENT_VERSION_PROJECTION = v.strictObject({
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
});

/**
 * read_document, `compare_with_version_id` branch: plain-text line diff
 * between two versions.
 */
export const READ_DOCUMENT_DIFF_PROJECTION = v.strictObject({
  entityId: readDocumentEntityId(),
  name: v.string(),
  diff: v.strictObject({
    // Entity-version handles, no chat ref kind.
    baseVersionId: passthroughId(),
    targetVersionId: passthroughId(),
    segments: v.array(
      v.variant("kind", [
        projectionBranch(
          v.strictObject({
            kind: v.picklist(["added", "removed", "unchanged", "gap"]),
            text: v.string(),
          }),
        ),
        projectionBranch(
          v.strictObject({
            kind: v.literal("changed"),
            runs: v.array(
              v.strictObject({
                kind: v.picklist(["same", "del", "ins"]),
                text: v.string(),
              }),
            ),
          }),
        ),
      ]),
    ),
  }),
});

/**
 * read_document, all three branches (`handleReadDocumentTool`,
 * `document-tools.ts`).
 */
export const READ_DOCUMENT_PROJECTION = v.union([
  projectionBranch(READ_DOCUMENT_DEFAULT_PROJECTION),
  projectionBranch(READ_DOCUMENT_VERSION_PROJECTION),
  projectionBranch(READ_DOCUMENT_DIFF_PROJECTION),
]);

/**
 * list_properties. Source of truth: `handleListPropertiesTool`
 * (`document-tools.ts`) — selected property columns mapped to
 * `{ id, name, valueType, status, writeMethod }`.
 */
export const LIST_PROPERTIES_PROJECTION = v.strictObject({
  properties: v.array(
    v.strictObject({
      id: chatRef("property"),
      name: v.string(),
      valueType: v.string(),
      status: v.string(),
      writeMethod: v.picklist(["set_field_value", "unsupported"]),
    }),
  ),
  // Opaque `[createdAt, id]` cursor; not UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_tasks, list branch. Source of truth: `handleListTasksTool`
 * (`matter-tools.ts`) — selected entity columns minus the cursor timestamp.
 */
export const LIST_TASKS_LIST_PROJECTION = v.strictObject({
  tasks: v.array(
    v.strictObject({
      id: chatEntityRef({ from: "inputParam", param: "matter_id" }),
      name: v.string(),
      status: v.nullable(v.string()),
      priority: v.nullable(v.string()),
      itemType: v.string(),
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
export const LIST_TASKS_DETAIL_PROJECTION = v.strictObject({
  task: v.strictObject({
    taskId: chatEntityRef({ from: "inputEntity", param: "task_id" }),
    name: v.string(),
    status: v.nullable(v.string()),
    priority: v.nullable(v.string()),
    itemType: v.string(),
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

export const LIST_TASKS_PROJECTION = v.union([
  projectionBranch(LIST_TASKS_LIST_PROJECTION),
  projectionBranch(LIST_TASKS_DETAIL_PROJECTION),
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

const clauseBodyProjection = v.array(clauseParagraphProjection);

/**
 * list_clauses, list branch. Source of truth: `handleListClausesTool`
 * (`knowledge-tools.ts`) forwarding `listClausesHandler` items, plus the
 * optional `listCategoriesHandler` catalog. Clause, category, and
 * clause-version ids are org-scoped library handles, not tenant refs.
 */
export const LIST_CLAUSES_LIST_PROJECTION = v.strictObject({
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
 * `metadata` is omitted by the handler; `createdBy` is the authoring user's id
 * (a `text` column, not a uuid column, but licensed defensively in case a
 * deployment's user ids happen to be uuid-shaped).
 */
export const LIST_CLAUSES_DETAIL_PROJECTION = v.strictObject({
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
export const LIST_CLAUSES_VERSION_PROJECTION = v.strictObject({
  version: v.strictObject({
    id: passthroughId(),
    version: v.number(),
    body: clauseBodyProjection,
    createdAt: v.string(),
  }),
});

export const LIST_CLAUSES_PROJECTION = v.union([
  projectionBranch(LIST_CLAUSES_LIST_PROJECTION),
  projectionBranch(LIST_CLAUSES_DETAIL_PROJECTION),
  projectionBranch(LIST_CLAUSES_VERSION_PROJECTION),
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
const playbookIdealLanguageProjection = v.variant("source", [
  projectionBranch(
    v.strictObject({
      source: v.literal("clause"),
      clauseId: passthroughId(),
      clauseVersion: v.optional(v.number()),
    }),
  ),
  projectionBranch(
    v.strictObject({ source: v.literal("inline"), text: v.string() }),
  ),
]);

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

/**
 * A graded position's standard (`positionStandardSchema`): the authored tier
 * ladder, or the passages quoted from a reference document. A passage is
 * provenance only, every identifier stripped: its words live in the source
 * matter's rows behind row security and never travel inside a playbook.
 */
const playbookStandardProjection = v.variant("source", [
  projectionBranch(
    v.strictObject({
      source: v.literal("tiers"),
      tiers: playbookTiersProjection,
    }),
  ),
  projectionBranch(
    v.strictObject({
      source: v.literal("reference"),
      passages: v.array(
        v.strictObject({
          id: strippedField(),
          workspaceId: strippedField(),
          entityId: strippedField(),
          fileFieldId: strippedField(),
          entityVersionId: strippedField(),
          blockId: strippedField(),
        }),
      ),
    }),
  ),
]);

// `content` is a `PropertyContent` config (a structural type descriptor with
// no stable leaf grammar across its variants): an unenumerated subtree, so
// the UUID backstop still guards its contents unlicensed.
const playbookAskManualProjection = v.strictObject({
  question: v.string(),
  content: unenumeratedJson(),
});

const playbookAskConfigProjection = v.variant("mode", [
  projectionBranch(
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
  ),
  projectionBranch(
    v.strictObject({
      mode: v.literal("manual"),
      question: v.string(),
      content: unenumeratedJson(),
    }),
  ),
]);

/**
 * One playbook position (`positionSchema`): the `extract` and `graded`
 * variants. `check` carries a recursive condition AST (`tConditionNode`):
 * unenumerated, so the backstop still guards it.
 */
const playbookPositionProjection = v.variant("mode", [
  projectionBranch(
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
  ),
  projectionBranch(
    v.strictObject({
      mode: v.literal("graded"),
      sourceId: passthroughId(),
      issue: v.string(),
      severity: v.string(),
      standard: playbookStandardProjection,
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
  ),
]);

/**
 * list_playbooks, list branch. Source of truth:
 * `listPlaybookDefinitionsHandler` (`handlers/playbooks/read.ts`), forwarded
 * verbatim as `{ items, nextCursor }`.
 */
export const LIST_PLAYBOOKS_LIST_PROJECTION = v.strictObject({
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
export const LIST_PLAYBOOKS_DETAIL_PROJECTION = v.strictObject({
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
      version: v.literal(3),
      items: v.array(playbookPositionProjection),
    }),
    status: v.string(),
    approvedAt: v.nullable(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }),
});

export const LIST_PLAYBOOKS_PROJECTION = v.union([
  projectionBranch(LIST_PLAYBOOKS_LIST_PROJECTION),
  projectionBranch(LIST_PLAYBOOKS_DETAIL_PROJECTION),
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
    entityId: v.nullable(
      chatEntityRef(
        workspace.from === "inputParam"
          ? { from: "inputParam", param: "matter_id" }
          : { from: "sibling", key: "workspaceId" },
      ),
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

/**
 * list_time_entries, list branch: matter_id is schema-required, so it is
 * every row's workspace. `visibility` is explicit because ordinary members
 * and interns receive only their own entries, not the matter total.
 */
export const LIST_TIME_ENTRIES_LIST_PROJECTION = v.strictObject({
  visibility: v.picklist([
    TIME_ENTRY_VISIBILITY.ALL_ENTRIES,
    TIME_ENTRY_VISIBILITY.OWN_ENTRIES,
  ]),
  entries: v.array(
    v.strictObject(timeEntryFieldEntries({ from: "inputParam" })),
  ),
  // Opaque `[dateWorked, id]` cursor, not UUID-formatted.
  nextCursor: v.nullable(passthroughId()),
});

/**
 * list_time_entries, detail branch. Detail mode may be reached by
 * time_entry_id alone, so the entry carries its resolved owning workspace: a
 * matter ref, and the entity's workspace source. `visibility` keeps the same
 * access contract truthful for a single entry.
 */
export const LIST_TIME_ENTRIES_DETAIL_PROJECTION = v.strictObject({
  visibility: v.picklist([
    TIME_ENTRY_VISIBILITY.ALL_ENTRIES,
    TIME_ENTRY_VISIBILITY.OWN_ENTRIES,
  ]),
  entry: v.strictObject({
    ...timeEntryFieldEntries({ from: "sibling" }),
    workspaceId: chatRef("matter"),
  }),
});

export const LIST_TIME_ENTRIES_PROJECTION = v.union([
  projectionBranch(LIST_TIME_ENTRIES_LIST_PROJECTION),
  projectionBranch(LIST_TIME_ENTRIES_DETAIL_PROJECTION),
]);

/**
 * resolve_rate. Source of truth: `handleResolveRateTool` (`billing-tools.ts`)
 * — a rate amount in minor units and a currency code, or nulls when no rate
 * table matches.
 */
export const RESOLVE_RATE_PROJECTION = v.strictObject({
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
/** list_invoices, list branch: invoice cards, no line items. */
export const LIST_INVOICES_LIST_PROJECTION = v.strictObject({
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
});

/** list_invoices, detail branch: one invoice with its time entries and expenses. */
export const LIST_INVOICES_DETAIL_PROJECTION = v.strictObject({
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
        entityId: v.nullable(
          chatEntityRef({
            from: "outputPath",
            path: "invoice.workspaceId",
          }),
        ),
        dateWorked: v.string(),
        billedMinutes: v.number(),
        rateAtEntry: v.number(),
        currency: v.string(),
        narrative: v.string(),
        invoiceNarrative: v.nullable(v.string()),
        status: v.string(),
        entity: v.nullable(invoiceLineEntityProjection()),
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
});

export const LIST_INVOICES_PROJECTION = v.union([
  projectionBranch(LIST_INVOICES_LIST_PROJECTION),
  projectionBranch(LIST_INVOICES_DETAIL_PROJECTION),
]);

/**
 * get_usage. Source of truth: `readOrgEntitlementHandler`
 * (`handlers/usage/get-entitlement.ts`): `{ entitlement: null }` when the
 * organization has no active plan, otherwise the plan/seat/period shape.
 * Entitlement and policy ids are org billing-plan handles, not tenant refs.
 */
export const GET_USAGE_NO_PLAN_PROJECTION = v.strictObject({
  entitlement: v.null(),
});

export const GET_USAGE_ENTITLED_PROJECTION = v.strictObject({
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
});

export const GET_USAGE_PROJECTION = v.union([
  projectionBranch(GET_USAGE_NO_PLAN_PROJECTION),
  projectionBranch(GET_USAGE_ENTITLED_PROJECTION),
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
export const SEARCH_CASE_LAW_PROJECTION = v.strictObject({
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
      // `buildCaseLawDecisionAppUrl` returns null while the public-law surface
      // is disabled (`isPublicLawAppUrlEnabled`), so the projected shape is
      // nullable; a non-nullable declaration would fail the strict parse and
      // take the tool off the chat surface on any deployment with the flag off.
      appUrl: v.nullable(v.string()),
      caseNumber: v.string(),
      citationCount: v.number(),
      country: v.string(),
      court: v.string(),
      decisionDate: v.nullable(v.string()),
      decisionId: passthroughId(),
      resourceName: passthroughId(),
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
 * (`stella-tools.ts`) mapping `readGatedDecisionWithDocument`. All ids are
 * public case-law corpus ids (decision, citation, source). `metadata` is
 * free-form public jsonb straight from the court source and cannot be
 * enumerated by path (same unenumerable-payload caveat as `list_audit_log`'s
 * `metadata`/`changes`, just over public rather than tenant data): declared
 * as an unenumerated subtree the walker skips, so the strict parse admits it
 * while the UUID backstop still guards every string inside, unlicensed.
 */
export const READ_CASE_LAW_DECISION_PROJECTION = v.strictObject({
  // Opaque compound `[textOffset, citationsCursor]` cursor.
  nextCursor: v.nullable(passthroughId()),
  decision: v.strictObject({
    // Nullable for the same reason as search_case_law's `results[].appUrl`.
    appUrl: v.nullable(v.string()),
    caseNumber: v.string(),
    citationsFrom: v.array(
      v.strictObject({
        id: passthroughId(),
        citationText: v.string(),
        citedDecisionId: v.nullable(passthroughId()),
        sectionIndex: v.nullable(v.number()),
      }),
    ),
    citationsTo: v.array(
      v.strictObject({
        id: passthroughId(),
        citationText: v.string(),
        citingDecisionId: passthroughId(),
        sectionIndex: v.nullable(v.number()),
      }),
    ),
    country: v.string(),
    court: v.string(),
    decisionDate: v.nullable(v.string()),
    decisionId: passthroughId(),
    resourceName: passthroughId(),
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
export const SEARCH_LEGISLATION_PROJECTION = v.union([
  // block branch: one article/disposition as raw XML.
  projectionBranch(
    v.strictObject({
      lawId: passthroughId(),
      blockId: passthroughId(),
      block: v.string(),
    }),
  ),
  // related branch: `findRelatedLaws` (`@stll/boe`).
  projectionBranch(
    v.strictObject({
      lawId: passthroughId(),
      relationType: v.string(),
      analysis: unenumeratedJson(),
    }),
  ),
  // default read branch: `{ law, structure }` (`getConsolidatedLaw` +
  // `getLawStructure`).
  projectionBranch(
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
  ),
  // search branch: the raw `BoeSearchResponse` envelope (every field
  // optional upstream).
  projectionBranch(
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
  ),
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
export const LOOKUP_BUSINESS_REGISTRY_PROJECTION = v.variant("type", [
  projectionBranch(
    v.strictObject({
      type: v.literal("lookup"),
      registry: v.string(),
      hit: v.nullable(businessRegistryHitProjection),
    }),
  ),
  projectionBranch(
    v.strictObject({
      type: v.literal("search"),
      registry: v.string(),
      hits: v.array(businessRegistryHitProjection),
    }),
  ),
]);

/**
 * The describe shape (`DescribeTemplateResult` success variant,
 * `lib/templates/template-fill-service.ts`) served by list_templates' detail
 * mode and echoed by save_template's configure branch. Field paths, input
 * types, options, and condition/formula expressions are structural
 * org-authored data; no ids anywhere.
 */
export const TEMPLATE_DESCRIBE_PROJECTION = v.strictObject({
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
  // Every {{#each}} loop over object items: `path` belongs in `values` as an
  // array of objects (one per `itemFieldPaths` entry), not a flat dotted key.
  // Manifest field entries for the loop's own contents still appear in
  // `fields` above; this is only the array-shape annotation `fields` cannot
  // carry on its own.
  arrays: v.array(
    v.strictObject({
      path: v.string(),
      itemFieldPaths: v.array(v.string()),
    }),
  ),
});

/**
 * list_templates. Source of truth: `handleListTemplatesTool` +
 * `describeTemplateDetail` (`template-tools.ts`). Template ids are org
 * template handles; detail mode's describe payload carries no id fields at
 * all.
 */
export const LIST_TEMPLATES_LIST_PROJECTION = v.strictObject({
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
});

export const LIST_TEMPLATES_PROJECTION = v.union([
  projectionBranch(LIST_TEMPLATES_LIST_PROJECTION),
  projectionBranch(TEMPLATE_DESCRIBE_PROJECTION),
]);

// --- Write-tool projections ---------------------------------------------------
// Write payloads are small acks and ids; each schema below mirrors the
// handler's `toolDataResult(...)` construction branch by branch. Input-param ref
// kinds were verified against each tool's actual `inputSchema` in
// `apps/api/src/mcp/*-tools.ts`. Params that carry no chat ref kind (task
// ids, user ids, template/clause/category/playbook ids, time-entry/version/
// link ids, plain fields) are passed to the handler verbatim and are
// documented per entry. The four mediated kinds are exactly the ones the chat
// ref registry mints: matter, entity, contact, property.

/** save_matter: create returns `{ matterId }`; update adds `updated: true`. */
export const SAVE_MATTER_PROJECTION = v.strictObject({
  matterId: chatRef("matter"),
  updated: v.optional(v.literal(true)),
});

export const DELETED_TRUE_PROJECTION = v.strictObject({
  deleted: v.literal(true),
});

/** save_contact: both branches return `{ contactId }`. */
export const SAVE_CONTACT_PROJECTION = v.strictObject({
  contactId: chatRef("contact"),
});

/**
 * save_task: create returns `{ taskId }` (a new entity whose workspace is the
 * resolved `matter_id`, required on create via `ensureActiveWorkspace`);
 * update returns `{ taskId, updated: true }` echoing the input task, which
 * hydration catches first via the dehydrated-entity reuse map, so the
 * `inputParam` source only drives the create case.
 */
export const SAVE_TASK_PROJECTION = v.strictObject({
  taskId: chatEntityRef({ from: "inputParam", param: "matter_id" }),
  updated: v.optional(v.literal(true)),
});

/**
 * link_matter_contact: link returns `{ workspaceContactId }` (a join-row
 * handle, not a tenant ref); unlink returns `{ unlinked: true }`.
 */
export const LINK_MATTER_CONTACT_LINK_PROJECTION = v.strictObject({
  workspaceContactId: passthroughId(),
});

export const LINK_MATTER_CONTACT_UNLINK_PROJECTION = v.strictObject({
  unlinked: v.literal(true),
});

export const LINK_MATTER_CONTACT_PROJECTION = v.union([
  projectionBranch(LINK_MATTER_CONTACT_LINK_PROJECTION),
  projectionBranch(LINK_MATTER_CONTACT_UNLINK_PROJECTION),
]);

/**
 * save_document: create returns `{ entityId }` (a new document whose
 * workspace is the resolved `matter_id`, required on create); update returns
 * `{ updated: true }`.
 */
export const SAVE_DOCUMENT_CREATE_PROJECTION = v.strictObject({
  entityId: chatEntityRef({ from: "inputParam", param: "matter_id" }),
});

export const SAVE_DOCUMENT_UPDATE_PROJECTION = v.strictObject({
  updated: v.literal(true),
});

export const SAVE_DOCUMENT_PROJECTION = v.union([
  projectionBranch(SAVE_DOCUMENT_CREATE_PROJECTION),
  projectionBranch(SAVE_DOCUMENT_UPDATE_PROJECTION),
]);

/** set_field_value returns `{}`. */
export const SET_FIELD_VALUE_PROJECTION = v.strictObject({});

/**
 * save_time_entry: both branches return `{ timeEntryId }` (update adds
 * `updated: true`); the time-entry id is a billing handle, not a tenant ref.
 */
export const SAVE_TIME_ENTRY_PROJECTION = v.strictObject({
  timeEntryId: passthroughId(),
  updated: v.optional(v.literal(true)),
});

/** delete_time_entry returns `{ deleted }` (a boolean from the handler). */
export const DELETE_TIME_ENTRY_PROJECTION = v.strictObject({
  deleted: v.boolean(),
});

/** save_clause: both branches return `{ clauseId }` (a library handle). */
export const SAVE_CLAUSE_PROJECTION = v.strictObject({
  clauseId: passthroughId(),
});

/** run_playbook returns `{ runPropertyCount }`: an integer, no id. */
export const RUN_PLAYBOOK_PROJECTION = v.strictObject({
  runPropertyCount: v.number(),
});

/**
 * manage_organization: add_member returns `{ memberId }`, remove_member
 * `{ removed: true, id }` (both membership-row handles, not tenant refs);
 * update_org_settings echoes only the scalar settings it changed.
 */
export const MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION = v.strictObject({
  memberId: passthroughId(),
});

export const MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION = v.strictObject({
  removed: v.literal(true),
  id: passthroughId(),
});

export const MANAGE_ORGANIZATION_SETTINGS_PROJECTION = v.strictObject({
  matterNumberPattern: v.optional(v.string()),
  matterNumberPadding: v.optional(v.number()),
  promptCachingEnabled: v.optional(v.boolean()),
  documentProcessingMode: v.optional(v.string()),
  memoryExtractionEnabled: v.optional(v.boolean()),
});

export const MANAGE_ORGANIZATION_PROJECTION = v.union([
  projectionBranch(MANAGE_ORGANIZATION_ADD_MEMBER_PROJECTION),
  projectionBranch(MANAGE_ORGANIZATION_REMOVE_MEMBER_PROJECTION),
  projectionBranch(MANAGE_ORGANIZATION_SETTINGS_PROJECTION),
]);

/**
 * set_practice_jurisdictions returns `{ practiceJurisdictions }`: country
 * codes and booleans, no id.
 */
export const SET_PRACTICE_JURISDICTIONS_PROJECTION = v.strictObject({
  practiceJurisdictions: v.array(
    v.strictObject({ countryCode: v.string(), isPrimary: v.boolean() }),
  ),
});

/**
 * save_template: create returns `{ templateId, name, fieldCount }` (template
 * handle); configure echoes the same describe shape list_templates' detail
 * mode serves, so the agent sees exactly what is now configured.
 */
export const SAVE_TEMPLATE_CREATE_PROJECTION = v.strictObject({
  templateId: passthroughId(),
  name: v.string(),
  fieldCount: v.number(),
});

export const SAVE_TEMPLATE_PROJECTION = v.union([
  projectionBranch(SAVE_TEMPLATE_CREATE_PROJECTION),
  projectionBranch(TEMPLATE_DESCRIBE_PROJECTION),
]);
