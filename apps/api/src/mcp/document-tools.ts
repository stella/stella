import { panic, Result } from "better-result";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import { entities, entityVersions, properties } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createEntitiesHandler } from "@/api/handlers/entities/create";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { deleteEntityVersionHandler } from "@/api/handlers/entities/delete-version";
import {
  ENTITY_LIST_TIMESTAMP_CURSOR_FORMAT,
  entityListCursorCondition,
  entityListTimestampCursorExpr,
} from "@/api/handlers/entities/list-cursor";
import { moveEntityHandler } from "@/api/handlers/entities/move";
import { readEntityByIdHandler } from "@/api/handlers/entities/read-by-id";
import { renameEntityHandler } from "@/api/handlers/entities/rename";
import { updateVersionDescriptionHandler } from "@/api/handlers/entities/update-version-description";
import { updateVersionLabelHandler } from "@/api/handlers/entities/update-version-label";
import { loadEntityVersionDocxText } from "@/api/handlers/entities/version-diff-sources";
import type { UpsertFieldContent } from "@/api/handlers/fields/upsert-by-id";
import { upsertFieldHandler } from "@/api/handlers/fields/upsert-by-id";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { isUuid } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
  brandPersistedPropertyId,
} from "@/api/lib/safe-id-boundaries";
import { buildLineDiffSegments } from "@/api/lib/text-diff";
import type { McpRequestContext } from "@/api/mcp/context";
import type {
  McpStructuredTextField,
  McpToolDefinition,
  McpToolHandler,
} from "@/api/mcp/tool-types";
import {
  DEFAULT_LIST_LIMIT,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  intProp,
  isToolErrorResult,
  MAX_LIST_LIMIT,
  nullableStringProp,
  stringProp,
  textResult,
} from "@/api/mcp/tool-utils";

type DocumentToolName =
  | "list_documents"
  | "read_document"
  | "create_document"
  | "update_document"
  | "delete_document"
  | "list_properties"
  | "set_field_value";

/** Kinds surfaced by list_documents; tasks/messages/links are other tools. */
const LISTABLE_ENTITY_KINDS = ["document", "folder"] as const;

/** Field/property value types set through set_field_value (binary/file excluded). */
const SETTABLE_VALUE_TYPES = [
  "text",
  "single-select",
  "multi-select",
  "date",
  "int",
] as const;

export const DOCUMENT_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the documents and folders in a matter. Use 'flat' mode to " +
      "enumerate every document and folder in the matter, or 'children' mode " +
      "to walk the folder tree one level at a time (pass parent_id to list a " +
      "folder's direct children, or omit it for the matter root). Returns each " +
      "entity's id, name, kind (document or folder), and parentId. Read a " +
      "document's metadata, fields, or versions with read_document.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID to list documents in"),
        mode: enumProp(
          "'flat' lists every document and folder in the matter; 'children' " +
            "lists only the direct children of parent_id (or the matter root " +
            "when parent_id is omitted). Defaults to 'flat', or 'children' when " +
            "parent_id is provided. Passing parent_id with mode 'flat' is " +
            "rejected.",
          ["flat", "children"],
        ),
        parent_id: stringProp(
          "Folder entity ID whose direct children to list. Only valid in " +
            "children mode; supplying it selects children mode when mode is " +
            "omitted and is rejected together with mode 'flat'.",
        ),
        limit: intProp("Max entities to return", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_documents call to fetch the next page",
          { maxLength: 512 },
        ),
      },
      required: ["matter_id"],
    },
    anonymized: { exposure: "anonymize", textFields: ["documents[].name"] },
    name: "list_documents",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a document's metadata and field values by entity ID. By default " +
      "returns the current version's name, kind, and field/property values. " +
      "Pass version_id to inspect a specific version instead. Pass version_id " +
      "and compare_with_version_id to get a plain-text line diff between two " +
      "versions. Pass include_versions to also return the version history. To " +
      "read the document's extracted text content, use read_content_across_matters.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Document entity ID"),
        version_id: stringProp(
          "Return this version's metadata and field values instead of the current version",
        ),
        compare_with_version_id: stringProp(
          "With version_id, return a plain-text line diff of this version (base) against version_id (target)",
        ),
        include_versions: {
          type: "boolean",
          description: "Also return the document's version history",
        },
        versions_cursor: stringProp(
          "Opaque cursor from a previous call to fetch the next page of version history",
          { maxLength: 512 },
        ),
      },
      required: ["entity_id"],
    },
    anonymized: {
      exposure: "anonymize",
      textFields: [
        "name",
        "fields[].value",
        "version.fields[].value",
        "versions[].label",
        "versions[].description",
        "diff.segments[].text",
      ],
    },
    name: "read_document",
    scope: "stella:read",
  },
  {
    description:
      "Create a document or folder in a matter. Provide the target matter, a " +
      "title, and optionally a parent folder. 'kind' defaults to 'document'; " +
      "pass 'folder' to create a folder. This creates an empty titled entity; " +
      "uploading file content is a separate step. Returns the new entity ID.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID to create the entity in"),
        title: stringProp("Display name for the new document or folder", {
          maxLength: LIMITS.entityNameMaxLength,
        }),
        parent_id: stringProp(
          "Folder entity ID to create the entity inside; omit for the matter root",
        ),
        kind: enumProp("Entity kind to create; defaults to 'document'", [
          "document",
          "folder",
        ]),
      },
      required: ["matter_id", "title"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "create_document",
    scope: "stella:documents_write",
  },
  {
    description:
      "Update a document: rename it, move it to a different folder, and/or edit " +
      "a version's label or description. Pass name to rename; parent_id to move " +
      "it into a folder or move_to_root to move it to the matter root; version_id " +
      "with label and/or description to annotate a version. At least one change " +
      "is required.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Document entity ID to update"),
        name: stringProp("New display name for the document", {
          maxLength: LIMITS.entityNameMaxLength,
        }),
        parent_id: stringProp("Folder entity ID to move the document into"),
        move_to_root: {
          type: "boolean",
          description:
            "Move the document to the matter root (no parent folder)",
        },
        version_id: stringProp(
          "Version ID to annotate; required when setting label or description",
        ),
        label: nullableStringProp(
          "New label for version_id; pass null to clear, empty string is not allowed, omit to leave unchanged",
          { maxLength: 128 },
        ),
        description: nullableStringProp(
          "New description for version_id; pass null to clear, empty string is not allowed, omit to leave unchanged",
          { maxLength: 1024 },
        ),
      },
      required: ["entity_id"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "update_document",
    scope: "stella:documents_write",
  },
  {
    annotations: { destructiveHint: true },
    description:
      "Delete a document and all its versions, or delete a single version when " +
      "version_id is provided (the current version is promoted to the next " +
      "latest; the only remaining version cannot be deleted). This is " +
      "irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Document entity ID to delete"),
        version_id: stringProp(
          "Delete only this version instead of the whole document",
        ),
      },
      required: ["entity_id"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "delete_document",
    scope: "stella:documents_write",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "List the property (column) definitions of a matter. Returns each " +
      "property's id, name, value type (text, single-select, multi-select, " +
      "date, or int), and status. Use the returned property id with " +
      "set_field_value to set a document's value for that property.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID to list properties for"),
        limit: intProp("Max properties to return", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_properties call to fetch the next page",
          { maxLength: 512 },
        ),
      },
      required: ["matter_id"],
    },
    anonymized: { exposure: "anonymize", textFields: ["properties[].name"] },
    name: "list_properties",
    scope: "stella:read",
  },
  {
    description:
      "Set a document's value for a property (a cell in the matter's table). " +
      "Pass the document entity_id, the property_id (from list_properties), and " +
      "a content object whose 'type' matches the property's value type: text " +
      "(value: string), single-select (value: string or null), multi-select " +
      "(value: array of strings), date (value: ISO YYYY-MM-DD or null), or int " +
      "(value: integer, optional currency: 3-letter ISO code). An empty value " +
      "clears the cell.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Document entity ID whose cell to set"),
        property_id: stringProp("Property ID, as returned by list_properties"),
        content: {
          type: "object",
          description: "The value to set; 'type' must match the property.",
          properties: {
            type: enumProp(
              "Value type; must match the property's value type",
              SETTABLE_VALUE_TYPES,
            ),
            value: {
              description:
                "The value: string for text, string or null for single-select, " +
                "array of strings for multi-select, ISO YYYY-MM-DD or null for " +
                "date, integer for int. Null or empty clears the cell.",
            },
            currency: stringProp(
              "For int values only: 3-letter ISO currency code, or null",
              { maxLength: 3 },
            ),
          },
          required: ["type", "value"],
        },
      },
      required: ["entity_id", "property_id", "content"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "set_field_value",
    scope: "stella:documents_write",
  },
] as const satisfies readonly McpToolDefinition[];

/**
 * Queue one anonymizable text field onto a structured egress plan, skipping
 * null/empty values. `apply` writes the anonymized value back into the payload.
 */
const pushTextField = ({
  apply,
  fields: sink,
  value,
  workspaceId,
}: {
  apply: (value: string) => void;
  fields: McpStructuredTextField[];
  value: string | null | undefined;
  workspaceId: string;
}): void => {
  if (typeof value === "string" && value.length > 0) {
    sink.push({ apply, value, workspaceId });
  }
};

/**
 * Wrap the request-scoped recorder so audit rows written by the reused backing
 * handlers carry the resolved workspace. The MCP recorder binds workspaceId to
 * null (org-scoped); the shared handlers build events without a workspaceId, so
 * inject it here per event (an event that sets its own workspaceId wins).
 */
const bindWorkspaceRecorder =
  (
    context: McpRequestContext,
    workspaceId: SafeId<"workspace">,
  ): AuditRecorder =>
  async (tx, event) => {
    const events: AuditEvent[] = Array.isArray(event) ? event : [event];
    // Events are freshly built by the backing handler and single-use, so stamp
    // the resolved workspace in place rather than cloning.
    for (const e of events) {
      if (e.workspaceId === undefined) {
        e.workspaceId = workspaceId;
      }
    }
    await context.recordAuditEvent(tx, events);
  };

/** Anonymize a field's tenant-authored text in place (values, file names). */
const pushFieldContentTexts = ({
  content,
  fields: sink,
  workspaceId,
}: {
  content: FieldContent;
  fields: McpStructuredTextField[];
  workspaceId: string;
}): void => {
  if (content.type === "text") {
    pushTextField({
      apply: (value) => {
        content.value = value;
      },
      fields: sink,
      value: content.value,
      workspaceId,
    });
    return;
  }
  if (content.type === "single-select") {
    pushTextField({
      apply: (value) => {
        content.value = value;
      },
      fields: sink,
      value: content.value,
      workspaceId,
    });
    return;
  }
  if (content.type === "multi-select") {
    const values = content.value;
    for (const [index, value] of values.entries()) {
      pushTextField({
        apply: (next) => {
          values[index] = next;
        },
        fields: sink,
        value,
        workspaceId,
      });
    }
    return;
  }
  if (content.type === "clip") {
    pushTextField({
      apply: (value) => {
        content.snippet = value;
      },
      fields: sink,
      value: content.snippet,
      workspaceId,
    });
    pushTextField({
      apply: (value) => {
        content.citation = value;
      },
      fields: sink,
      value: content.citation,
      workspaceId,
    });
    return;
  }
  if (content.type === "file") {
    pushTextField({
      apply: (value) => {
        content.fileName = value;
      },
      fields: sink,
      value: content.fileName,
      workspaceId,
    });
  }
};

type EntityFieldRow = { content: FieldContent };

const pushEntityFieldsTexts = ({
  entityFields,
  fields: sink,
  workspaceId,
}: {
  entityFields: EntityFieldRow[];
  fields: McpStructuredTextField[];
  workspaceId: string;
}): void => {
  for (const field of entityFields) {
    pushFieldContentTexts({
      content: field.content,
      fields: sink,
      workspaceId,
    });
  }
};

/** Entity kind the document tools operate on (same set list_documents surfaces). */
type DocumentEntityKind = (typeof LISTABLE_ENTITY_KINDS)[number];

const isDocumentEntityKind = (kind: string): kind is DocumentEntityKind =>
  (LISTABLE_ENTITY_KINDS as readonly string[]).includes(kind);

/**
 * Outcome of resolving an entity for a document tool. `wrong-kind` is kept
 * distinct from `not-found` so callers can tell a caller that their own
 * (accessible) entity is a task/message/link rather than silently 404ing.
 */
type ResolvedDocumentEntity =
  | {
      status: "ok";
      workspaceId: SafeId<"workspace">;
      kind: DocumentEntityKind;
      name: string;
    }
  | { status: "not-found" }
  | { status: "wrong-kind" };

/**
 * Resolve the accessible workspace that owns an entity. The document tools
 * (read/update/delete/set_field_value) only operate on the kinds list_documents
 * surfaces (document, folder); other kinds an entity ID happens to name are
 * rejected as `wrong-kind` rather than acted on.
 */
const resolveEntityWorkspace = async ({
  context,
  entityId,
}: {
  context: McpRequestContext;
  entityId: SafeId<"entity">;
}): Promise<ResolvedDocumentEntity> => {
  if (context.accessibleWorkspaceIds.length === 0) {
    return { status: "not-found" };
  }
  const entity = await context.scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: { eq: entityId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      columns: { workspaceId: true, kind: true, name: true },
    }),
  );
  if (!entity) {
    return { status: "not-found" };
  }
  if (!isDocumentEntityKind(entity.kind)) {
    return { status: "wrong-kind" };
  }
  return {
    status: "ok",
    workspaceId: entity.workspaceId,
    kind: entity.kind,
    name: entity.name,
  };
};

/**
 * Map a non-`ok` entity resolution to a tool error. `wrong-kind` names the
 * caller's own accessible entity's shape (no cross-tenant disclosure); a
 * miss stays a generic not-found so a probed ID reveals nothing.
 */
const documentEntityNotAvailable = (
  resolution: { status: "not-found" } | { status: "wrong-kind" },
) =>
  resolution.status === "wrong-kind"
    ? errorResult("Not a document or folder entity")
    : errorResult("Document not found or not accessible");

// The list cursor is [createdAt, entityId]; the query resolves the (createdAt,
// id) boundary via the keyset condition. A malformed cursor is rejected here so
// it never reaches SQL.
const decodeEntityPageCursor = (
  cursor: string,
): { createdAt: string; id: SafeId<"entity"> } | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }
  const [createdAt, id] = parts;
  if (typeof createdAt !== "string" || typeof id !== "string") {
    return null;
  }
  return { createdAt, id: brandPersistedEntityId(id) };
};

/**
 * Prefer a cross-field (`partial_check`) validation message when one is
 * present, falling back to the hand-written shape hint for structural failures.
 * The partialCheck rules carry actionable messages ("parent_id requires mode
 * 'children'", etc.); valibot's raw structural errors are less useful to a tool
 * caller than the generic shape summary.
 */
const crossFieldOrGeneric = (
  issues: readonly v.BaseIssue<unknown>[],
  genericMessage: string,
): string =>
  issues.find((issue) => issue.type === "partial_check")?.message ??
  genericMessage;

const listDocumentsArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.pipe(v.string(), v.minLength(1)),
    mode: v.optional(v.picklist(["flat", "children"])),
    parent_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
  // parent_id scopes to a folder's children, so it is meaningless in flat mode
  // (which enumerates the whole matter). Reject the explicit contradiction; an
  // omitted mode with parent_id resolves to children (see handler default).
  v.forward(
    v.partialCheck(
      [["mode"], ["parent_id"]],
      ({ mode, parent_id }) => mode !== "flat" || parent_id === undefined,
      "parent_id requires mode 'children'",
    ),
    ["parent_id"],
  ),
);

// In children mode the parent filter narrows to one folder's direct children
// (or the matter root when parent_id is absent); flat mode ignores parent_id
// and enumerates the whole matter.
const documentsParentCondition = ({
  mode,
  parentId,
}: {
  mode: "flat" | "children";
  parentId: SafeId<"entity"> | undefined;
}) => {
  if (parentId !== undefined) {
    return eq(entities.parentId, parentId);
  }
  if (mode === "children") {
    return sql`${entities.parentId} is null`;
  }
  return undefined;
};

const handleListDocumentsTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    workspace: ["read"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listDocumentsArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { matter_id: string, mode?: 'flat'|'children', parent_id?: string, limit?: integer, cursor?: string }",
      ),
    );
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (!workspaceId) {
    return errorResult("Matter not found or not accessible");
  }

  const parentId =
    parsed.output.parent_id === undefined
      ? undefined
      : brandPersistedEntityId(parsed.output.parent_id);
  // parent_id implies children mode: passing a folder to enumerate its children
  // is the only reason to send it, and flat + parent_id is rejected upstream.
  const mode =
    parsed.output.mode ?? (parentId !== undefined ? "children" : "flat");

  let boundary: { createdAt: string; id: SafeId<"entity"> } | null = null;
  if (parsed.output.cursor !== undefined) {
    boundary = decodeEntityPageCursor(parsed.output.cursor);
    if (boundary === null) {
      return errorResult("Invalid cursor");
    }
  }

  const limit = parsed.output.limit ?? DEFAULT_LIST_LIMIT;

  const parentCondition = documentsParentCondition({ mode, parentId });

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        createdAt: entityListTimestampCursorExpr(sql`${entities.createdAt}`),
        id: entities.id,
        name: entities.name,
        kind: entities.kind,
        parentId: entities.parentId,
      })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, workspaceId),
          inArray(entities.kind, [...LISTABLE_ENTITY_KINDS]),
          parentCondition,
          entityListCursorCondition(boundary),
        ),
      )
      .orderBy(asc(entities.createdAt), asc(entities.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.createdAt, item.id]),
  });

  const documents = page.items.map(({ createdAt: _createdAt, ...doc }) => doc);

  const textFields: McpStructuredTextField[] = [];
  for (const doc of documents) {
    pushTextField({
      apply: (value) => {
        doc.name = value;
      },
      fields: textFields,
      value: doc.name,
      workspaceId,
    });
  }

  return {
    egress: "structured",
    payload: { documents, nextCursor: page.nextCursor },
    textFields,
  };
};

// Version-history cursor is [versionNumber, versionId]; keyset paginates
// newest-first.
const decodeVersionsPageCursor = (
  cursor: string,
): { versionNumber: number; id: SafeId<"entityVersion"> } | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }
  const [versionNumber, id] = parts;
  if (
    typeof versionNumber !== "number" ||
    !Number.isInteger(versionNumber) ||
    typeof id !== "string"
  ) {
    return null;
  }
  return { versionNumber, id: brandPersistedEntityVersionId(id) };
};

const readDocumentArgsSchema = v.pipe(
  v.strictObject({
    entity_id: v.pipe(v.string(), v.minLength(1)),
    version_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    compare_with_version_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    include_versions: v.optional(v.boolean()),
    versions_cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
  // A diff needs both endpoints: compare_with_version_id (base) is only
  // meaningful alongside version_id (target).
  v.forward(
    v.partialCheck(
      [["version_id"], ["compare_with_version_id"]],
      ({ version_id, compare_with_version_id }) =>
        compare_with_version_id === undefined || version_id !== undefined,
      "compare_with_version_id requires version_id (the target version)",
    ),
    ["compare_with_version_id"],
  ),
);

/**
 * One version-history entry. `label` and `description` are tenant-authored, so
 * both must be pushed through `pushTextField` on the anonymized surface; typing
 * them concretely (rather than `unknown[]` at the call site) is what makes that
 * omission visible.
 */
type VersionHistoryEntry = {
  id: SafeId<"entityVersion">;
  versionNumber: number;
  stamp: string | null;
  label: string | null;
  description: string | null;
  createdAt: string;
};

type VersionHistoryPage = {
  versions: VersionHistoryEntry[];
  nextCursor: string | null;
};

const loadVersionHistory = async ({
  context,
  workspaceId,
  entityId,
  cursor,
}: {
  context: McpRequestContext;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  cursor: string | undefined;
}): Promise<VersionHistoryPage | ReturnType<typeof errorResult>> => {
  let boundary: { versionNumber: number; id: SafeId<"entityVersion"> } | null =
    null;
  if (cursor !== undefined) {
    boundary = decodeVersionsPageCursor(cursor);
    if (boundary === null) {
      return errorResult("Invalid cursor");
    }
  }

  const limit = LIMITS.versionsPageSizeDefault;
  const keyset = boundary
    ? or(
        lt(entityVersions.versionNumber, boundary.versionNumber),
        and(
          eq(entityVersions.versionNumber, boundary.versionNumber),
          lt(entityVersions.id, boundary.id),
        ),
      )
    : undefined;

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        id: entityVersions.id,
        versionNumber: entityVersions.versionNumber,
        stamp: entityVersions.stamp,
        label: entityVersions.label,
        description: entityVersions.description,
        createdAt: entityVersions.createdAt,
      })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.entityId, entityId),
          eq(entityVersions.workspaceId, workspaceId),
          keyset,
        ),
      )
      .orderBy(desc(entityVersions.versionNumber), desc(entityVersions.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      encodePaginationCursor([item.versionNumber, item.id]),
  });

  return {
    versions: page.items.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      stamp: version.stamp,
      label: version.label,
      description: version.description,
      createdAt: version.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
};

const handleReadDocumentTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    workspace: ["read"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(readDocumentArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { entity_id: string, ... }",
      ),
    );
  }

  const entityId = brandPersistedEntityId(parsed.output.entity_id);
  const owner = await resolveEntityWorkspace({ context, entityId });
  if (owner.status !== "ok") {
    return documentEntityNotAvailable(owner);
  }
  const { workspaceId } = owner;

  // Version comparison: plain-text line diff of two versions' DOCX content.
  if (parsed.output.compare_with_version_id !== undefined) {
    // The schema's partialCheck guarantees version_id is present whenever
    // compare_with_version_id is; a missing target here is an invariant break.
    const targetVersion =
      parsed.output.version_id ??
      panic("compare_with_version_id passed schema check without version_id");
    const targetVersionId = brandPersistedEntityVersionId(targetVersion);
    const baseVersionId = brandPersistedEntityVersionId(
      parsed.output.compare_with_version_id,
    );
    const baseResult = await Result.gen(() =>
      loadEntityVersionDocxText({
        safeDb: context.safeDb,
        workspaceId,
        organizationId: context.organizationId,
        entityId,
        versionId: baseVersionId,
      }),
    );
    if (Result.isError(baseResult)) {
      return errorResult(baseResult.error.message);
    }
    const targetResult = await Result.gen(() =>
      loadEntityVersionDocxText({
        safeDb: context.safeDb,
        workspaceId,
        organizationId: context.organizationId,
        entityId,
        versionId: targetVersionId,
      }),
    );
    if (Result.isError(targetResult)) {
      return errorResult(targetResult.error.message);
    }

    const segments = buildLineDiffSegments(
      baseResult.value,
      targetResult.value,
    );
    const payload = {
      entityId,
      name: owner.name,
      diff: { baseVersionId, targetVersionId, segments },
    };

    const textFields: McpStructuredTextField[] = [];
    pushTextField({
      apply: (value) => {
        payload.name = value;
      },
      fields: textFields,
      value: payload.name,
      workspaceId,
    });
    for (const segment of segments) {
      if (segment.kind === "changed") {
        for (const run of segment.runs) {
          pushTextField({
            apply: (value) => {
              run.text = value;
            },
            fields: textFields,
            value: run.text,
            workspaceId,
          });
        }
        continue;
      }
      pushTextField({
        apply: (value) => {
          segment.text = value;
        },
        fields: textFields,
        value: segment.text,
        workspaceId,
      });
    }

    return { egress: "structured", payload, textFields };
  }

  // Specific version metadata + field values.
  if (parsed.output.version_id !== undefined) {
    const versionId = brandPersistedEntityVersionId(parsed.output.version_id);
    const versionRow = await context.scopedDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
        },
        columns: {
          id: true,
          versionNumber: true,
          stamp: true,
          label: true,
          description: true,
          createdAt: true,
        },
      }),
    );
    if (!versionRow) {
      return errorResult("Version not found");
    }
    const versionFields = await context.scopedDb((tx) =>
      // SAFETY: one version's fields, bounded by LIMITS.propertiesCount via the
      // unique (propertyId, entityVersionId) index.
      // eslint-disable-next-line require-query-limit/require-query-limit
      tx.query.fields.findMany({
        where: { entityVersionId: { eq: versionId } },
        columns: { id: true, propertyId: true, content: true },
      }),
    );

    const payload = {
      entityId,
      name: owner.name,
      version: {
        ...versionRow,
        createdAt: versionRow.createdAt.toISOString(),
        fields: versionFields,
      },
    };
    const textFields: McpStructuredTextField[] = [];
    pushTextField({
      apply: (value) => {
        payload.name = value;
      },
      fields: textFields,
      value: payload.name,
      workspaceId,
    });
    pushTextField({
      apply: (value) => {
        payload.version.label = value;
      },
      fields: textFields,
      value: payload.version.label,
      workspaceId,
    });
    pushTextField({
      apply: (value) => {
        payload.version.description = value;
      },
      fields: textFields,
      value: payload.version.description,
      workspaceId,
    });
    pushEntityFieldsTexts({
      entityFields: versionFields,
      fields: textFields,
      workspaceId,
    });
    return { egress: "structured", payload, textFields };
  }

  // Default: current version metadata + field values.
  const currentResult = await Result.gen(() =>
    readEntityByIdHandler({ safeDb: context.safeDb, workspaceId, entityId }),
  );
  if (Result.isError(currentResult)) {
    return errorResult(currentResult.error.message);
  }
  const current = currentResult.value;

  let versionHistory: VersionHistoryPage | undefined;
  if (parsed.output.include_versions === true) {
    const history = await loadVersionHistory({
      context,
      workspaceId,
      entityId,
      cursor: parsed.output.versions_cursor,
    });
    if (isToolErrorResult(history)) {
      return history;
    }
    versionHistory = history;
  }

  const payload = {
    entityId: current.entityId,
    kind: current.kind,
    name: current.name,
    fields: current.fields,
    ...(versionHistory
      ? {
          versions: versionHistory.versions,
          versionsNextCursor: versionHistory.nextCursor,
        }
      : {}),
  };

  const textFields: McpStructuredTextField[] = [];
  pushTextField({
    apply: (value) => {
      payload.name = value;
    },
    fields: textFields,
    value: payload.name,
    workspaceId,
  });
  pushEntityFieldsTexts({
    entityFields: current.fields,
    fields: textFields,
    workspaceId,
  });
  // Version history carries tenant-authored label/description. payload.versions
  // holds the same entry references, so writing back here anonymizes the
  // payload in place, matching the specific-version branch above.
  if (versionHistory) {
    for (const version of versionHistory.versions) {
      pushTextField({
        apply: (value) => {
          version.label = value;
        },
        fields: textFields,
        value: version.label,
        workspaceId,
      });
      pushTextField({
        apply: (value) => {
          version.description = value;
        },
        fields: textFields,
        value: version.description,
        workspaceId,
      });
    }
  }

  return { egress: "structured", payload, textFields };
};

const createDocumentArgsSchema = v.strictObject({
  matter_id: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.entityNameMaxLength),
  ),
  parent_id: v.optional(v.pipe(v.string(), v.minLength(1))),
  kind: v.optional(v.picklist(["document", "folder"])),
});

const handleCreateDocumentTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    entity: ["create"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(createDocumentArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { matter_id: string, title: string, parent_id?: string, kind?: 'document'|'folder' }",
    );
  }

  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }

  const created = await Result.gen(() =>
    createEntitiesHandler({
      safeDb: context.safeDb,
      workspaceId,
      userId: context.userId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: {
        kind: parsed.output.kind ?? "document",
        parentId:
          parsed.output.parent_id === undefined
            ? null
            : brandPersistedEntityId(parsed.output.parent_id),
        name: parsed.output.title,
      },
    }),
  );
  if (Result.isError(created)) {
    return errorResult(created.error.message);
  }

  return textResult({ entityId: created.value.entityId });
};

const updateDocumentArgsSchema = v.pipe(
  v.strictObject({
    entity_id: v.pipe(v.string(), v.minLength(1)),
    name: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(LIMITS.entityNameMaxLength),
      ),
    ),
    parent_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    move_to_root: v.optional(v.boolean()),
    version_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    label: v.optional(
      v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    ),
    description: v.optional(
      v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1024))),
    ),
  }),
  // At least one mutation must be requested; an empty update is a no-op the
  // caller almost certainly did not intend. Root-level (no single culprit
  // field to forward the issue onto).
  v.partialCheck(
    [
      ["name"],
      ["parent_id"],
      ["move_to_root"],
      ["version_id"],
      ["label"],
      ["description"],
    ],
    (input) => {
      const wantsRename = input.name !== undefined;
      const wantsMove =
        input.parent_id !== undefined || input.move_to_root === true;
      const wantsVersionEdit =
        input.version_id !== undefined &&
        (input.label !== undefined || input.description !== undefined);
      return wantsRename || wantsMove || wantsVersionEdit;
    },
    "Provide at least one change: name, parent_id/move_to_root, or version_id with label/description",
  ),
  // parent_id (move into folder) and move_to_root (move to matter root) are
  // opposite moves; accepting both is ambiguous.
  v.forward(
    v.partialCheck(
      [["parent_id"], ["move_to_root"]],
      ({ parent_id, move_to_root }) =>
        parent_id === undefined || move_to_root !== true,
      "Provide either parent_id or move_to_root, not both",
    ),
    ["move_to_root"],
  ),
  // label/description annotate a specific version, so they require version_id.
  v.forward(
    v.partialCheck(
      [["version_id"], ["label"], ["description"]],
      ({ version_id, label, description }) =>
        (label === undefined && description === undefined) ||
        version_id !== undefined,
      "label and description require version_id",
    ),
    ["version_id"],
  ),
);

/**
 * Validate the entities update_document will touch before any mutation runs, so
 * an invalid target cannot fail after an earlier rename already committed. Not
 * transactional: a target could be deleted or change kind between this check
 * and the mutation (an accepted TOCTOU window); this only removes the common
 * partial-mutation failure mode. Returns an error result, or null when valid.
 */
const validateUpdateDocumentTargets = async ({
  context,
  entityId,
  parentId,
  versionId,
  workspaceId,
}: {
  context: McpRequestContext;
  entityId: SafeId<"entity">;
  parentId: SafeId<"entity"> | undefined;
  versionId: SafeId<"entityVersion"> | undefined;
  workspaceId: SafeId<"workspace">;
}): Promise<ReturnType<typeof errorResult> | null> => {
  if (parentId !== undefined) {
    const parent = await context.scopedDb((tx) =>
      tx.query.entities.findFirst({
        where: {
          id: { eq: parentId },
          workspaceId: { eq: workspaceId },
        },
        columns: { kind: true },
      }),
    );
    if (!parent) {
      return errorResult("Target folder not found or not accessible");
    }
    if (parent.kind !== "folder") {
      return errorResult("parent_id must be a folder entity");
    }
  }
  if (versionId !== undefined) {
    const version = await context.scopedDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
      }),
    );
    if (!version) {
      return errorResult("Version not found");
    }
  }
  return null;
};

/** Apply the version label/description edits. Returns an error result or null. */
const applyVersionAnnotations = async ({
  context,
  description,
  entityId,
  label,
  recordAuditEvent,
  versionId,
  workspaceId,
}: {
  context: McpRequestContext;
  description: string | null | undefined;
  entityId: SafeId<"entity">;
  label: string | null | undefined;
  recordAuditEvent: AuditRecorder;
  versionId: SafeId<"entityVersion">;
  workspaceId: SafeId<"workspace">;
}): Promise<ReturnType<typeof errorResult> | null> => {
  if (label !== undefined) {
    const labelled = await Result.gen(() =>
      updateVersionLabelHandler({
        safeDb: context.safeDb,
        workspaceId,
        entityId,
        versionId,
        label,
        recordAuditEvent,
      }),
    );
    if (Result.isError(labelled)) {
      return errorResult(labelled.error.message);
    }
  }
  if (description !== undefined) {
    const described = await Result.gen(() =>
      updateVersionDescriptionHandler({
        safeDb: context.safeDb,
        workspaceId,
        entityId,
        versionId,
        description,
        recordAuditEvent,
      }),
    );
    if (Result.isError(described)) {
      return errorResult(described.error.message);
    }
  }
  return null;
};

const handleUpdateDocumentTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    entity: ["update"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(updateDocumentArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { entity_id: string, ... }",
      ),
    );
  }
  const input = parsed.output;

  // Cross-field shape rules (at least one change, parent_id/move_to_root
  // exclusivity, label/description require version_id) are enforced by
  // updateDocumentArgsSchema above; only DB-dependent target validation remains.
  const wantsMove =
    input.parent_id !== undefined || input.move_to_root === true;

  const entityId = brandPersistedEntityId(input.entity_id);
  const owner = await resolveEntityWorkspace({ context, entityId });
  if (owner.status !== "ok") {
    return documentEntityNotAvailable(owner);
  }
  const { workspaceId } = owner;
  // Documents in an archived matter are read-only, matching the HTTP entity
  // routes behind the active-only workspace group.
  const active = ensureActiveWorkspace({ context, workspaceId });
  if (typeof active !== "string") {
    return active;
  }
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);

  const parentId =
    input.parent_id === undefined
      ? undefined
      : brandPersistedEntityId(input.parent_id);
  const versionId =
    input.version_id === undefined
      ? undefined
      : brandPersistedEntityVersionId(input.version_id);

  const targetError = await validateUpdateDocumentTargets({
    context,
    entityId,
    parentId,
    versionId,
    workspaceId,
  });
  if (targetError) {
    return targetError;
  }

  if (input.name !== undefined) {
    const name = input.name;
    const renamed = await Result.gen(() =>
      renameEntityHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: { entityId, name },
      }),
    );
    if (Result.isError(renamed)) {
      return errorResult(renamed.error.message);
    }
  }

  if (wantsMove) {
    const moved = await Result.gen(() =>
      moveEntityHandler({
        safeDb: context.safeDb,
        workspaceId,
        recordAuditEvent,
        body: { entityId, parentId: parentId ?? null },
      }),
    );
    if (Result.isError(moved)) {
      return errorResult(moved.error.message);
    }
  }

  if (versionId !== undefined) {
    const annotationError = await applyVersionAnnotations({
      context,
      description: input.description,
      entityId,
      label: input.label,
      recordAuditEvent,
      versionId,
      workspaceId,
    });
    if (annotationError) {
      return annotationError;
    }
  }

  return textResult({ updated: true });
};

const deleteDocumentArgsSchema = v.strictObject({
  entity_id: v.pipe(v.string(), v.minLength(1)),
  version_id: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const handleDeleteDocumentTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(deleteDocumentArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { entity_id: string, version_id?: string }",
    );
  }

  const entityId = brandPersistedEntityId(parsed.output.entity_id);
  const owner = await resolveEntityWorkspace({ context, entityId });
  if (owner.status !== "ok") {
    return documentEntityNotAvailable(owner);
  }
  const { workspaceId } = owner;
  // A document in an archived matter is read-only, matching the HTTP entity
  // routes behind the active-only workspace group.
  const active = ensureActiveWorkspace({ context, workspaceId });
  if (typeof active !== "string") {
    return active;
  }
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);

  // Deleting a single version is an entity update; deleting the whole document
  // needs the stronger delete permission.
  if (parsed.output.version_id !== undefined) {
    if (!roles[context.memberRole].authorize({ entity: ["update"] }).success) {
      return errorResult("Forbidden");
    }
    const versionId = brandPersistedEntityVersionId(parsed.output.version_id);
    const deleted = await Result.gen(() =>
      deleteEntityVersionHandler({
        safeDb: context.safeDb,
        organizationId: context.organizationId,
        workspaceId,
        entityId,
        versionId,
        recordAuditEvent,
      }),
    );
    if (Result.isError(deleted)) {
      return errorResult(deleted.error.message);
    }
    return textResult({ deleted: true });
  }

  if (!roles[context.memberRole].authorize({ entity: ["delete"] }).success) {
    return errorResult("Forbidden");
  }
  const deleted = await Result.gen(() =>
    deleteEntitiesHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      workspaceId,
      recordAuditEvent,
      body: { entityIds: [entityId] },
    }),
  );
  if (Result.isError(deleted)) {
    return errorResult(deleted.error.message);
  }
  return textResult({ deleted: true });
};

const listPropertiesArgsSchema = v.strictObject({
  matter_id: v.pipe(v.string(), v.minLength(1)),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_LIST_LIMIT)),
  ),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

const decodePropertyPageCursor = (
  cursor: string,
): { createdAt: string; id: string } | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }
  const [createdAt, id] = parts;
  if (
    typeof createdAt !== "string" ||
    typeof id !== "string" ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }
  return { createdAt, id };
};

const handleListPropertiesTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    workspace: ["read"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listPropertiesArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { matter_id: string, limit?: integer, cursor?: string }",
    );
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (!workspaceId) {
    return errorResult("Matter not found or not accessible");
  }

  let boundary: { createdAt: string; id: string } | null = null;
  if (parsed.output.cursor !== undefined) {
    boundary = decodePropertyPageCursor(parsed.output.cursor);
    if (boundary === null) {
      return errorResult("Invalid cursor");
    }
  }
  const limit = parsed.output.limit ?? DEFAULT_LIST_LIMIT;

  const boundaryCondition = boundary
    ? or(
        sql`${properties.createdAt} > ${boundary.createdAt}::timestamp`,
        and(
          sql`${properties.createdAt} = ${boundary.createdAt}::timestamp`,
          gt(properties.id, brandPersistedPropertyId(boundary.id)),
        ),
      )
    : undefined;

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        createdAt: sql<string>`to_char(${properties.createdAt}, ${ENTITY_LIST_TIMESTAMP_CURSOR_FORMAT})`,
        id: properties.id,
        name: properties.name,
        content: properties.content,
        status: properties.status,
      })
      .from(properties)
      .where(and(eq(properties.workspaceId, workspaceId), boundaryCondition))
      .orderBy(asc(properties.createdAt), asc(properties.id))
      .limit(limit + 1),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.createdAt, item.id]),
  });

  const propertyList = page.items.map((property) => ({
    id: property.id,
    name: property.name,
    valueType: property.content.type,
    status: property.status,
  }));

  const textFields: McpStructuredTextField[] = [];
  for (const property of propertyList) {
    pushTextField({
      apply: (value) => {
        property.name = value;
      },
      fields: textFields,
      value: property.name,
      workspaceId,
    });
  }

  return {
    egress: "structured",
    payload: { properties: propertyList, nextCursor: page.nextCursor },
    textFields,
  };
};

const setFieldValueContentSchema = v.variant("type", [
  v.strictObject({ type: v.literal("text"), value: v.string() }),
  v.strictObject({
    type: v.literal("single-select"),
    value: v.nullable(v.string()),
  }),
  v.strictObject({
    type: v.literal("multi-select"),
    value: v.array(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    type: v.literal("date"),
    value: v.nullable(v.pipe(v.string(), v.isoDate())),
  }),
  v.strictObject({
    type: v.literal("int"),
    value: v.pipe(v.number(), v.integer()),
    currency: v.optional(v.nullable(v.pipe(v.string(), v.length(3)))),
  }),
]);

const setFieldValueArgsSchema = v.strictObject({
  entity_id: v.pipe(v.string(), v.minLength(1)),
  property_id: v.pipe(v.string(), v.minLength(1)),
  content: setFieldValueContentSchema,
});

type SetFieldValueContent = v.InferOutput<typeof setFieldValueContentSchema>;

const toFieldContent = (content: SetFieldValueContent): UpsertFieldContent => {
  if (content.type === "int") {
    return {
      version: 1,
      type: "int",
      value: content.value,
      currency: content.currency ?? null,
    };
  }
  if (content.type === "multi-select") {
    return { version: 1, type: "multi-select", value: content.value };
  }
  if (content.type === "single-select") {
    return { version: 1, type: "single-select", value: content.value };
  }
  if (content.type === "date") {
    return { version: 1, type: "date", value: content.value };
  }
  return { version: 1, type: "text", value: content.value };
};

const handleSetFieldValueTool: McpToolHandler = async ({ args, context }) => {
  const hasPermission = roles[context.memberRole].authorize({
    entity: ["create", "update"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(setFieldValueArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { entity_id: string, property_id: string, content: { type, value, currency? } }",
    );
  }
  if (!isUuid(parsed.output.property_id)) {
    return errorResult("Invalid input: property_id must be a UUID");
  }

  const entityId = brandPersistedEntityId(parsed.output.entity_id);
  const owner = await resolveEntityWorkspace({ context, entityId });
  if (owner.status !== "ok") {
    return documentEntityNotAvailable(owner);
  }
  const { workspaceId } = owner;
  // Setting a cell in an archived matter is a write, so it is rejected the same
  // way the HTTP field routes behind the active-only workspace group are.
  const active = ensureActiveWorkspace({ context, workspaceId });
  if (typeof active !== "string") {
    return active;
  }

  const result = await Result.gen(() =>
    upsertFieldHandler({
      safeDb: context.safeDb,
      workspaceId,
      userId: context.userId,
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      body: {
        entityId,
        propertyId: brandPersistedPropertyId(parsed.output.property_id),
        content: toFieldContent(parsed.output.content),
      },
    }),
  );
  if (Result.isError(result)) {
    return errorResult(result.error.message);
  }

  return textResult({});
};

export const DOCUMENT_TOOL_HANDLERS = {
  create_document: handleCreateDocumentTool,
  delete_document: handleDeleteDocumentTool,
  list_documents: handleListDocumentsTool,
  list_properties: handleListPropertiesTool,
  read_document: handleReadDocumentTool,
  set_field_value: handleSetFieldValueTool,
  update_document: handleUpdateDocumentTool,
} satisfies Record<DocumentToolName, McpToolHandler>;
