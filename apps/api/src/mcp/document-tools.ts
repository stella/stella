import { panic, Result } from "better-result";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { DOCUMENT_VERSION_UPLOAD_TRANSPORT } from "@stll/api-contract";

import {
  DEFAULT_DOCUMENT_PROCESSING_MODE,
  entities,
  entityVersions,
  properties,
} from "@/api/db/schema";
import type {
  FieldContent,
  PropertyContentType,
} from "@/api/db/schema-validators";
import { createEntitiesHandler } from "@/api/handlers/entities/create";
import { deleteEntitiesHandler } from "@/api/handlers/entities/delete";
import { deleteEntityVersionHandler } from "@/api/handlers/entities/delete-version";
import { readEntityByIdHandler } from "@/api/handlers/entities/get";
import { moveEntityHandler } from "@/api/handlers/entities/move";
import { renameEntityHandler } from "@/api/handlers/entities/rename";
import { updateVersionDescriptionHandler } from "@/api/handlers/entities/update-version-description";
import { updateVersionLabelHandler } from "@/api/handlers/entities/update-version-label";
import { loadEntityVersionDocxText } from "@/api/handlers/entities/version-diff-sources";
import type { UpsertFieldContent } from "@/api/handlers/fields/upsert-by-id";
import { upsertFieldHandler } from "@/api/handlers/fields/upsert-by-id";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DELETED_TRUE_PROJECTION,
  LIST_DOCUMENTS_PROJECTION,
  LIST_PROPERTIES_PROJECTION,
  READ_DOCUMENT_DEFAULT_PROJECTION,
  READ_DOCUMENT_DIFF_PROJECTION,
  READ_DOCUMENT_PROJECTION,
  READ_DOCUMENT_VERSION_PROJECTION,
  SAVE_DOCUMENT_CREATE_PROJECTION,
  SAVE_DOCUMENT_PROJECTION,
  SAVE_DOCUMENT_UPDATE_PROJECTION,
  SET_FIELD_VALUE_PROJECTION,
} from "@/api/lib/chat/projections";
import { isUuid } from "@/api/lib/custom-schema";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { selectCurrentExtractedContent } from "@/api/lib/document-content-provenance";
import {
  DOCUMENT_PROCESSING_FAILURE_CODE,
  DOCUMENT_PROCESSING_KIND,
  DOCUMENT_PROCESSING_REQUIRED_STATUS,
} from "@/api/lib/document-processing-contract";
import {
  entityListCursorCondition,
  entityListTimestampCursorExpr,
} from "@/api/lib/entities/list-cursor";
import { shouldGeneratePdfDerivative } from "@/api/lib/files/pdf-derivative-policy";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
  brandPersistedPropertyId,
} from "@/api/lib/safe-id-boundaries";
import { resolveExtractionMimeType } from "@/api/lib/search/extract-content";
import { canExtractMimeType } from "@/api/lib/search/extractable-mime-types";
import { buildLineDiffSegments } from "@/api/lib/text-diff";
import type { VersionDiffSegment } from "@/api/lib/text-diff";
import { includes } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  DOCUMENT_UPLOAD_APP_RESOURCE_URI,
  OPEN_DOCUMENT_VERSION_UPLOAD_INPUT_SCHEMA,
  UPLOAD_DOCUMENT_VERSION_INPUT_SCHEMA,
  uploadRemoteDocumentVersion,
} from "@/api/mcp/document-file-upload";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  InternalToolResult,
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  McpToolResponse,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  DEFAULT_LIST_LIMIT,
  ensureActiveWorkspace,
  ensureWorkspaceAccess,
  errorResult,
  internalFailureResult,
  isToolErrorResult,
  MAX_LIST_LIMIT,
  notFoundResult,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
  uuidInputSchema,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

type DocumentToolName =
  | "list_documents"
  | "read_document"
  | "save_document"
  | "upload_document_version"
  | "open_document_version_upload"
  | "delete_document"
  | "list_properties"
  | "set_field_value";

/** Kinds surfaced by list_documents; tasks/messages/links are other tools. */
const LISTABLE_ENTITY_KINDS = ["document", "folder"] as const;

const PROPERTY_WRITE_METHODS = {
  file: "unsupported",
  // Neither is settable through set_field_value: money needs a currency
  // alongside the amount and a person needs resolving to a workspace member.
  money: "unsupported",
  person: "unsupported",
  text: "set_field_value",
  "single-select": "set_field_value",
  "multi-select": "set_field_value",
  date: "set_field_value",
  int: "set_field_value",
} as const satisfies Record<
  PropertyContentType,
  "set_field_value" | "unsupported"
>;

// --- Text-field specs (plan 049, Option B) --------------------------------

/**
 * Normalized read/write pair over one field's tenant-authored text unit. A
 * `FieldContent`'s text-bearing value is not always a lone scalar: a
 * multi-select holds several array-indexed values, a clip holds two named
 * fields (snippet, citation), and a "changed" diff segment holds several
 * inline runs. Every text-bearing shape becomes one unit apiece; a single
 * `McpTextFieldSpec` then just iterates `TextUnit`s without re-deriving the
 * union's shape at every call site.
 */
type TextUnit = {
  read: () => string | null | undefined;
  write: (value: string) => void;
};

/** One entity/version field row as fetched from the DB — text-field specs
 * only ever touch `content`. */
type EntityFieldRow = { content: FieldContent };

/**
 * The former `pushFieldContentTexts` helper's full discriminated-union walk,
 * narrowed here once: `text`/`single-select` are a scalar unit; `multi-select`
 * yields one unit per array index, writing back through the same array
 * reference; `clip` yields its snippet and citation as two named units;
 * `file` yields its fileName. `date`/`int`/`error`/`pending`/`unsupported`
 * carry no tenant-authored text and contribute nothing.
 */
const fieldContentTextUnits = (
  fields: readonly EntityFieldRow[],
): readonly TextUnit[] =>
  fields.flatMap(({ content }): TextUnit[] => {
    if (content.type === "text") {
      return [
        {
          read: () => content.value,
          write: (value) => {
            content.value = value;
          },
        },
      ];
    }
    if (content.type === "single-select") {
      return [
        {
          read: () => content.value,
          write: (value) => {
            content.value = value;
          },
        },
      ];
    }
    if (content.type === "multi-select") {
      const values = content.value;
      return values.map((_value, index) => ({
        read: () => values[index],
        write: (value: string) => {
          values[index] = value;
        },
      }));
    }
    if (content.type === "clip") {
      return [
        {
          read: () => content.snippet,
          write: (value) => {
            content.snippet = value;
          },
        },
        {
          read: () => content.citation,
          write: (value) => {
            content.citation = value;
          },
        },
      ];
    }
    if (content.type === "file") {
      return [
        {
          read: () => content.fileName,
          write: (value) => {
            content.fileName = value;
          },
        },
      ];
    }
    return [];
  });

/**
 * Same union-walk shape as `fieldContentTextUnits`, over a line-diff's
 * segments: a "changed" segment's several inline runs each become one unit;
 * every other segment kind is a single scalar unit over its own `text`.
 */
const diffSegmentTextUnits = (
  segments: readonly VersionDiffSegment[],
): readonly TextUnit[] =>
  segments.flatMap((segment): TextUnit[] => {
    if (segment.kind === "changed") {
      return segment.runs.map((run) => ({
        read: () => run.text,
        write: (value: string) => {
          run.text = value;
        },
      }));
    }
    return [
      {
        read: () => segment.text,
        write: (value: string) => {
          segment.text = value;
        },
      },
    ];
  });

/**
 * One anonymize-mode spec over a flat list of `TextUnit`s, shared by every
 * field-values path (`fields[].value`, `version.fields[].value`) and the diff
 * path (`diff.segments[].text`) below.
 */
const textUnitTextFieldSpec = <TPayload>({
  path,
  units,
  workspaceId,
}: {
  path: string;
  units: (payload: TPayload) => readonly TextUnit[];
  workspaceId: string;
}): McpTextFieldSpec<TPayload> =>
  defineTextFieldSpec({
    path,
    items: units,
    scope: () => workspaceId,
    read: (unit: TextUnit) => unit.read(),
    apply: (unit: TextUnit, value) => {
      unit.write(value);
    },
  });

/**
 * One anonymize-mode spec over a single `{ name: string }`-shaped payload,
 * shared across read_document's default/version/diff branches (P1: the whole
 * branch response shares one resolved `workspaceId`).
 */
const nameTextFieldSpec = <TPayload extends { name: string }>(
  workspaceId: string,
): McpTextFieldSpec<TPayload> =>
  defineTextFieldSpec({
    path: "name",
    items: (payload: TPayload) => [payload],
    scope: () => workspaceId,
    read: (item: TPayload) => item.name,
    apply: (item: TPayload, value) => {
      item.name = value;
    },
  });

// --- list_documents / list_properties -------------------------------------

type NamedListItem = { name: string };

const DOCUMENT_LIST_TEXT_FIELD_PATH = "documents[].name";

const documentListTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<{ documents: readonly NamedListItem[] }>[] => [
  defineTextFieldSpec({
    path: DOCUMENT_LIST_TEXT_FIELD_PATH,
    items: (payload) => payload.documents,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
];

const PROPERTY_LIST_TEXT_FIELD_PATH = "properties[].name";

const propertyListTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<{ properties: readonly NamedListItem[] }>[] => [
  defineTextFieldSpec({
    path: PROPERTY_LIST_TEXT_FIELD_PATH,
    items: (payload) => payload.properties,
    scope: () => workspaceId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
];

// --- read_document ---------------------------------------------------------

/** Version-history fields this surface redacts. See `VersionHistoryEntry`
 * below for the full row shape fetched from the DB. */
type VersionHistoryTextItem = {
  label: string | null;
  description: string | null;
};

type ReadDocumentDefaultPayload = {
  name: string;
  fields: readonly EntityFieldRow[];
  versions?: readonly VersionHistoryTextItem[];
};

/** `versions` is only present when `include_versions` was requested — a
 * genuine absence, not a structural invariant, so this reads as an explicit
 * presence check rather than a `?? []` fallback. */
const readDocumentVersionHistoryItems = (
  payload: ReadDocumentDefaultPayload,
): readonly VersionHistoryTextItem[] => {
  if (payload.versions === undefined) {
    return [];
  }
  return payload.versions;
};

/**
 * Default branch (current version): the entity's own name, its field values
 * (full `FieldContent` union recursion via `fieldContentTextUnits`), and,
 * when `include_versions` was requested, each version-history entry's label
 * and description — the exact fields Wave 1 declared but never pushed;
 * deriving the declaration from this same spec closes that gap structurally.
 */
const readDocumentDefaultTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<ReadDocumentDefaultPayload>[] => [
  nameTextFieldSpec<ReadDocumentDefaultPayload>(workspaceId),
  textUnitTextFieldSpec({
    path: "fields[].value",
    units: (payload: ReadDocumentDefaultPayload) =>
      fieldContentTextUnits(payload.fields),
    workspaceId,
  }),
  defineTextFieldSpec({
    path: "versions[].label",
    items: readDocumentVersionHistoryItems,
    scope: () => workspaceId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "versions[].description",
    items: readDocumentVersionHistoryItems,
    scope: () => workspaceId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

type ReadDocumentVersionDetailPayload = {
  name: string;
  version: {
    label: string | null;
    description: string | null;
    fields: readonly EntityFieldRow[];
  };
};

/**
 * version_id branch: the entity name, the requested version's own
 * label/description (pushed by the original handler but never declared —
 * another instance of the declared-vs-pushed drift this migration closes),
 * and that version's field values.
 */
const readDocumentVersionDetailTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<ReadDocumentVersionDetailPayload>[] => [
  nameTextFieldSpec<ReadDocumentVersionDetailPayload>(workspaceId),
  defineTextFieldSpec({
    path: "version.label",
    items: (payload: ReadDocumentVersionDetailPayload) => [payload.version],
    scope: () => workspaceId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "version.description",
    items: (payload: ReadDocumentVersionDetailPayload) => [payload.version],
    scope: () => workspaceId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  textUnitTextFieldSpec({
    path: "version.fields[].value",
    units: (payload: ReadDocumentVersionDetailPayload) =>
      fieldContentTextUnits(payload.version.fields),
    workspaceId,
  }),
];

type ReadDocumentDiffPayload = {
  name: string;
  diff: { segments: readonly VersionDiffSegment[] };
};

/**
 * compare_with_version_id branch: the entity name and every diff segment's
 * text (a "changed" segment's several inline runs, or the segment's own text
 * for every other kind).
 */
const readDocumentDiffTextFieldSpecs = (
  workspaceId: string,
): readonly McpTextFieldSpec<ReadDocumentDiffPayload>[] => [
  nameTextFieldSpec<ReadDocumentDiffPayload>(workspaceId),
  textUnitTextFieldSpec({
    path: "diff.segments[].text",
    units: (payload: ReadDocumentDiffPayload) =>
      diffSegmentTextUnits(payload.diff.segments),
    workspaceId,
  }),
];

// read_document's three branches (default/version/diff) never populate the
// same response at once, but each has its own payload shape, so the declared
// path list is the union of all three specs' paths (deduped: `name` is
// shared by every branch).
const READ_DOCUMENT_TEXT_FIELD_PATHS = [
  ...new Set([
    ...deriveTextFieldPaths(readDocumentDefaultTextFieldSpecs("")),
    ...deriveTextFieldPaths(readDocumentVersionDetailTextFieldSpecs("")),
    ...deriveTextFieldPaths(readDocumentDiffTextFieldSpecs("")),
  ]),
];

const UPLOAD_DOCUMENT_VERSION_TOOL_DEFINITION = defineValibotMcpTool({
  _meta: {
    "openai/fileParams": ["file"],
  },
  annotations: {
    title: "Upload document version",
    idempotentHint: false,
    openWorldHint: true,
  },
  description:
    "Upload an attached host file as a new version of an existing document. " +
    "Pass entity_id and file. Use open_document_version_upload only when the " +
    "host cannot supply MCP file parameters. The upload uses stella's standard " +
    "presigned, checksum-verified, scanned, and audited file-version pipeline.",
  inputSchema: UPLOAD_DOCUMENT_VERSION_INPUT_SCHEMA,
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: DOCUMENT_VERSION_UPLOAD_TRANSPORT.toolName,
  scope: "stella:documents_write",
});

const OPEN_DOCUMENT_VERSION_UPLOAD_TOOL_DEFINITION = defineValibotMcpTool({
  _meta: {
    ui: {
      resourceUri: DOCUMENT_UPLOAD_APP_RESOURCE_URI,
      visibility: ["model", "app"],
    },
  },
  annotations: {
    title: "Open document version upload",
    idempotentHint: false,
    openWorldHint: true,
  },
  description:
    "Open a portable file picker for uploading a new version of an existing " +
    "document. Use only when upload_document_version cannot receive a host file " +
    "reference; do not use when the host already supplied an attached file.",
  inputSchema: OPEN_DOCUMENT_VERSION_UPLOAD_INPUT_SCHEMA,
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: DOCUMENT_VERSION_UPLOAD_TRANSPORT.pickerToolName,
  scope: "stella:documents_write",
});

/** Entity kind the document tools operate on (same set list_documents surfaces). */
type DocumentEntityKind = (typeof LISTABLE_ENTITY_KINDS)[number];

const isDocumentEntityKind = (kind: string): kind is DocumentEntityKind =>
  includes(LISTABLE_ENTITY_KINDS, kind);

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
    : notFoundResult("Document not found or not accessible");

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

const listDocumentsArgsSchema = v.pipe(
  v.strictObject({
    matter_id: v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Matter ID to list documents in."),
    ),
    mode: v.optional(
      v.pipe(
        v.picklist(["flat", "children"]),
        v.description(
          "'flat' lists every document and folder in the matter; 'children' " +
            "lists only the direct children of parent_id (or the matter " +
            "root when parent_id is omitted). Defaults to 'flat', or 'children' when " +
            "parent_id is provided. Passing parent_id with mode 'flat' is " +
            "rejected.",
        ),
      ),
    ),
    parent_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "Folder entity ID whose direct children to list. Only valid in " +
            "children mode; supplying it selects children mode when mode is " +
            "omitted and is rejected together with mode 'flat'.",
        ),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(MAX_LIST_LIMIT),
        v.description("Max entities to return"),
      ),
    ),
    cursor: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(512),
        v.description(
          "Opaque cursor from a previous list_documents call to fetch the next page",
        ),
      ),
    ),
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

const handleListDocumentsTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_DOCUMENTS_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    workspace: ["read"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listDocumentsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
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
      return structuredErrorResult({
        code: "validation_error",
        message: "Invalid cursor",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
      });
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

  const payload = {
    documents,
    nextCursor: page.nextCursor,
  } satisfies v.InferInput<typeof LIST_DOCUMENTS_PROJECTION>;
  const textFields = runTextFieldSpecs(
    documentListTextFieldSpecs(workspaceId),
    payload,
  );

  return { egress: "structured", payload, textFields };
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
    entity_id: uuidInputSchema("Document entity ID"),
    version_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "Return this version's metadata and field values instead of the current version",
        ),
      ),
    ),
    compare_with_version_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "With version_id, return a plain-text line diff of this version (base) against version_id (target)",
        ),
      ),
    ),
    include_versions: v.optional(
      v.pipe(
        v.boolean(),
        v.description("Also return the document's version history"),
      ),
    ),
    versions_cursor: v.optional(
      v.pipe(
        v.string(),
        v.maxLength(512),
        v.description(
          "Cursor from a previous call for the next page of version history",
        ),
      ),
    ),
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
 * both must be redacted through `readDocumentDefaultTextFieldSpecs` on the
 * anonymized surface; typing them concretely (rather than `unknown[]` at the
 * call site) is what makes that omission visible.
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
      return structuredErrorResult({
        code: "validation_error",
        message: "Invalid cursor",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
      });
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
          isNull(entityVersions.deletedAt),
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

type CurrentDocumentForState = {
  currentVersionCreatedAt: Date;
  currentVersionId: SafeId<"entityVersion">;
  processingFileFieldId: SafeId<"field"> | null;
  fields: {
    content: FieldContent;
    id: SafeId<"field">;
    propertyId: SafeId<"property">;
  }[];
};

type DocumentContentState =
  | { status: "not_applicable" }
  | {
      status: "ready";
      source: "direct_docx" | "extracted_text";
      sourceVersionId: SafeId<"entityVersion">;
      updatedAt: string;
    }
  | {
      status: "pending";
      processingKind: typeof DOCUMENT_PROCESSING_KIND;
      runId: SafeId<"documentProcessingRun"> | null;
      sourceVersionId: SafeId<"entityVersion">;
    }
  | {
      status: typeof DOCUMENT_PROCESSING_REQUIRED_STATUS;
      sourceVersionId: SafeId<"entityVersion">;
      remediation:
        | {
            type: "action";
            tool: "invoke_capability";
            arguments: {
              capability: "entities.ocr.create";
              input: {
                params: {
                  matterId: SafeId<"workspace">;
                  entityId: SafeId<"entity">;
                };
                body: { fieldId: SafeId<"field"> };
              };
            };
          }
        | {
            type: "escalation";
            requiredScope: "stella:matters_write";
            requiredPermission: "entity:update";
            instruction: string;
          };
    }
  | {
      status: "failed";
      processingKind: typeof DOCUMENT_PROCESSING_KIND;
      runId: SafeId<"documentProcessingRun">;
      sourceVersionId: SafeId<"entityVersion">;
      errorCode: typeof DOCUMENT_PROCESSING_FAILURE_CODE;
      retryable: true;
    }
  | {
      status: "unsupported";
      sourceVersionId: SafeId<"entityVersion">;
      reason: string;
    };

type DocumentSearchIndexState =
  | { status: "not_applicable" }
  | {
      status: "ready";
      sourceVersionId: SafeId<"entityVersion">;
      updatedAt: string;
    }
  | { status: "pending"; sourceVersionId: SafeId<"entityVersion"> }
  | {
      status: "failed";
      runId: SafeId<"documentProcessingRun">;
      sourceVersionId: SafeId<"entityVersion">;
      errorCode: "search_index_failed";
      retryable: true;
    }
  | {
      status: "unsupported";
      sourceVersionId: SafeId<"entityVersion">;
      reason: string;
    };

type DocumentProcessingStates = {
  contentState: DocumentContentState;
  searchIndexState: DocumentSearchIndexState;
};

// Runs for one immutable source are unique by processing kind and processor
// version. This spans far more revisions than a document version can
// realistically survive while keeping the state read bounded.
const DOCUMENT_PROCESSING_RUNS_PER_SOURCE_MAX = 1000;

const loadDocumentProcessingStates = async ({
  context,
  current,
  entityId,
  workspaceId,
}: {
  context: McpRequestContext;
  current: CurrentDocumentForState;
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
}): Promise<DocumentProcessingStates> => {
  const sourceField =
    current.processingFileFieldId === null
      ? null
      : (current.fields.find(
          ({ id }) => id === current.processingFileFieldId,
        ) ?? panic("Extraction source field is not current"));
  if (sourceField !== null && sourceField.content.type !== "file") {
    panic("Extraction source field does not contain a file");
  }
  const sourceFile =
    sourceField?.content.type === "file" ? sourceField.content : null;
  const sourceFieldId = sourceField?.id ?? null;
  const [extracted, runs, searchDocument, settings, latestVersion] =
    await context.scopedDb(
      async (tx) =>
        await Promise.all([
          tx.query.extractedContent.findFirst({
            where: {
              entityId: { eq: entityId },
              organizationId: { eq: context.organizationId },
              workspaceId: { eq: workspaceId },
            },
            columns: {
              charCount: true,
              extractedAt: true,
              sourceEntityVersionId: true,
              sourceFieldId: true,
              sourceFileId: true,
              sourceSha256Hex: true,
            },
          }),
          sourceFile
            ? tx.query.documentProcessingRuns.findMany({
                where: {
                  entityId: { eq: entityId },
                  entityVersionId: { eq: current.currentVersionId },
                  fieldId: {
                    eq:
                      sourceFieldId ??
                      panic("Processing source file requires a field"),
                  },
                  organizationId: { eq: context.organizationId },
                  sourceFileId: { eq: sourceFile.id },
                  sourceSha256Hex: { eq: sourceFile.sha256Hex },
                  workspaceId: { eq: workspaceId },
                },
                columns: {
                  errorCode: true,
                  fieldId: true,
                  finishedAt: true,
                  id: true,
                  kind: true,
                  sourceFileId: true,
                  sourceSha256Hex: true,
                  status: true,
                },
                orderBy: { createdAt: "desc" },
                limit: DOCUMENT_PROCESSING_RUNS_PER_SOURCE_MAX,
              })
            : Promise.resolve([]),
          tx.query.searchDocuments.findFirst({
            where: {
              entityId: { eq: entityId },
              organizationId: { eq: context.organizationId },
              workspaceId: { eq: workspaceId },
            },
            columns: { updatedAt: true },
          }),
          tx.query.organizationSettings.findFirst({
            where: { organizationId: { eq: context.organizationId } },
            columns: { documentProcessingMode: true },
          }),
          // Provenance fence: include tombstones so a rollback cannot make a
          // withdrawn version's legacy extraction appear current again.
          tx.query.entityVersions.findFirst({
            where: {
              entityId: { eq: entityId },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
            orderBy: { versionNumber: "desc", id: "desc" },
          }),
        ]),
    );

  if (!sourceFile) {
    return {
      contentState: { status: "not_applicable" },
      searchIndexState:
        searchDocument &&
        searchDocument.updatedAt >= current.currentVersionCreatedAt
          ? {
              status: "ready",
              sourceVersionId: current.currentVersionId,
              updatedAt: searchDocument.updatedAt.toISOString(),
            }
          : {
              status: "pending",
              sourceVersionId: current.currentVersionId,
            },
    };
  }

  const currentExtracted = selectCurrentExtractedContent({
    extracted,
    allowLegacy: latestVersion?.id === current.currentVersionId,
    currentVersionCreatedAt: current.currentVersionCreatedAt,
    currentVersionId: current.currentVersionId,
    fields: current.fields,
  });
  // Keep this defensive check even though the database query applies the same
  // source identity fence; test doubles and future query refactors must not let
  // a superseded file influence current state.
  const sourceRuns = runs.filter(
    (run) =>
      run.sourceFileId === sourceFile.id &&
      run.fieldId === sourceFieldId &&
      run.sourceSha256Hex === sourceFile.sha256Hex,
  );
  const nativeRun = sourceRuns.find((run) => run.kind === "native-extraction");
  const ocrRun = sourceRuns.find((run) => run.kind === "ocr");
  const ocrTerminalCancellation =
    ocrRun?.status === "cancelled" &&
    (ocrRun.errorCode === "policy_disabled" ||
      ocrRun.errorCode === "workspace_unavailable");
  // `sourceRuns` preserves the query's newest-first order. Terminal OCR
  // cancellations did not invalidate the preceding native index.
  const latestIndexRun = sourceRuns.find(
    (run) =>
      !(
        run.kind === "ocr" &&
        run.status === "cancelled" &&
        (run.errorCode === "policy_disabled" ||
          run.errorCode === "workspace_unavailable")
      ),
  );
  const searchFailure =
    latestIndexRun?.status === "failed" &&
    latestIndexRun.errorCode === "search_index_failed"
      ? latestIndexRun
      : undefined;
  // A later optional OCR attempt can fail before producing a replacement
  // projection. In that case the successful native projection and its index
  // remain valid for this exact source file.
  const completedIndexRun = sourceRuns.find(
    (run) => run.status === "succeeded",
  );
  const extractionMimeType = resolveExtractionMimeType({
    fileName: sourceFile.fileName,
    mimeType: sourceFile.mimeType,
  });
  const extractionCanBecomeAvailable =
    canExtractMimeType(extractionMimeType) ||
    sourceFile.pdfFileId !== null ||
    shouldGeneratePdfDerivative({
      encrypted: sourceFile.encrypted,
      mimeType: sourceFile.mimeType,
    });
  // Manual OCR deliberately bypasses the organization's automatic-processing
  // policy. Only an external MCP request can invoke the generic capability;
  // internal chat deliberately receives an escalation instead.
  const canQueueManualOcr =
    context.request !== undefined &&
    hasEffectiveAuthority(context, {
      entity: ["update"],
    }) &&
    context.grantedScopes.includes("stella:matters_write");

  const resolveContentState = (): DocumentContentState => {
    if (
      !sourceFile.encrypted &&
      sourceFile.mimeType === DOCX_MIME_TYPE &&
      currentExtracted === null &&
      nativeRun?.status === "failed" &&
      nativeRun.errorCode !== "search_index_failed"
    ) {
      return {
        status: "failed",
        processingKind: DOCUMENT_PROCESSING_KIND,
        runId: nativeRun.id,
        sourceVersionId: current.currentVersionId,
        errorCode: DOCUMENT_PROCESSING_FAILURE_CODE,
        retryable: true,
      };
    }
    if (!sourceFile.encrypted && sourceFile.mimeType === DOCX_MIME_TYPE) {
      return {
        status: "ready",
        source: "direct_docx",
        sourceVersionId: current.currentVersionId,
        updatedAt: current.currentVersionCreatedAt.toISOString(),
      };
    }
    if (currentExtracted && currentExtracted.charCount > 0) {
      return {
        status: "ready",
        source: "extracted_text",
        sourceVersionId: current.currentVersionId,
        updatedAt: currentExtracted.extractedAt.toISOString(),
      };
    }
    if (
      ocrRun?.status === "failed" &&
      ocrRun.errorCode !== "search_index_failed"
    ) {
      return {
        status: "failed",
        processingKind: DOCUMENT_PROCESSING_KIND,
        runId: ocrRun.id,
        sourceVersionId: current.currentVersionId,
        errorCode: DOCUMENT_PROCESSING_FAILURE_CODE,
        retryable: true,
      };
    }
    if (ocrRun?.status === "queued" || ocrRun?.status === "running") {
      return {
        status: "pending",
        processingKind: DOCUMENT_PROCESSING_KIND,
        runId: ocrRun.id,
        sourceVersionId: current.currentVersionId,
      };
    }
    if (
      ocrRun?.status === "cancelled" &&
      ocrRun.errorCode === "workspace_unavailable"
    ) {
      return {
        status: "unsupported",
        sourceVersionId: current.currentVersionId,
        reason:
          "Document processing is unavailable while the matter is not active.",
      };
    }
    if (
      currentExtracted?.charCount === 0 &&
      (ocrRun === undefined || ocrTerminalCancellation) &&
      extractionMimeType === PDF_MIME_TYPE &&
      (settings?.documentProcessingMode ?? DEFAULT_DOCUMENT_PROCESSING_MODE) ===
        "off"
    ) {
      return {
        status: DOCUMENT_PROCESSING_REQUIRED_STATUS,
        sourceVersionId: current.currentVersionId,
        remediation: canQueueManualOcr
          ? {
              type: "action",
              tool: "invoke_capability",
              arguments: {
                capability: "entities.ocr.create",
                input: {
                  // The remediation is handed to an agent to call verbatim, so
                  // it speaks the public name the capability advertises.
                  params: { matterId: workspaceId, entityId },
                  body: {
                    fieldId:
                      sourceFieldId ??
                      panic("OCR remediation requires a source field"),
                  },
                },
              },
            }
          : {
              type: "escalation",
              requiredScope: "stella:matters_write",
              requiredPermission: "entity:update",
              instruction:
                "Ask a matter editor to start document processing for this field.",
            },
      };
    }
    if (currentExtracted) {
      return {
        status: "ready",
        source: "extracted_text",
        sourceVersionId: current.currentVersionId,
        updatedAt: currentExtracted.extractedAt.toISOString(),
      };
    }
    if (nativeRun?.status === "failed") {
      return {
        status: "failed",
        processingKind: DOCUMENT_PROCESSING_KIND,
        runId: nativeRun.id,
        sourceVersionId: current.currentVersionId,
        errorCode: DOCUMENT_PROCESSING_FAILURE_CODE,
        retryable: true,
      };
    }
    if (sourceFile.encrypted) {
      return {
        status: "unsupported",
        sourceVersionId: current.currentVersionId,
        reason: "Encrypted document content cannot be extracted.",
      };
    }
    if (!extractionCanBecomeAvailable) {
      return {
        status: "unsupported",
        sourceVersionId: current.currentVersionId,
        reason: `Content extraction is not supported for ${sourceFile.mimeType}.`,
      };
    }
    return {
      status: "pending",
      processingKind: DOCUMENT_PROCESSING_KIND,
      runId:
        nativeRun?.status === "queued" || nativeRun?.status === "running"
          ? nativeRun.id
          : null,
      sourceVersionId: current.currentVersionId,
    };
  };

  const resolveSearchIndexState = (): DocumentSearchIndexState => {
    if (searchFailure) {
      return {
        status: "failed",
        runId: searchFailure.id,
        sourceVersionId: current.currentVersionId,
        errorCode: "search_index_failed",
        retryable: true,
      };
    }
    const sourceRunCompleted = completedIndexRun !== undefined;
    const freshUntrackedProjection =
      latestIndexRun === undefined &&
      searchDocument !== undefined &&
      searchDocument.updatedAt >= current.currentVersionCreatedAt;
    if (searchDocument && (sourceRunCompleted || freshUntrackedProjection)) {
      return {
        status: "ready",
        sourceVersionId: current.currentVersionId,
        updatedAt: (
          completedIndexRun?.finishedAt ?? searchDocument.updatedAt
        ).toISOString(),
      };
    }
    return {
      status: "pending",
      sourceVersionId: current.currentVersionId,
    };
  };

  const contentState = resolveContentState();
  const searchIndexState = resolveSearchIndexState();
  return { contentState, searchIndexState };
};

const handleReadDocumentTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_DOCUMENT_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    workspace: ["read"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(readDocumentArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
      return internalFailureResult(baseResult.error);
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
      return internalFailureResult(targetResult.error);
    }

    const segments = buildLineDiffSegments(
      baseResult.value,
      targetResult.value,
    );
    const payload = {
      entityId,
      name: owner.name,
      diff: { baseVersionId, targetVersionId, segments },
    } satisfies v.InferInput<typeof READ_DOCUMENT_DIFF_PROJECTION>;

    const textFields = runTextFieldSpecs(
      readDocumentDiffTextFieldSpecs(workspaceId),
      payload,
    );

    return { egress: "structured", payload, textFields };
  }

  // Specific version metadata + field values.
  if (parsed.output.version_id !== undefined) {
    const versionId = brandPersistedEntityVersionId(parsed.output.version_id);
    // Read the version metadata and its fields in one tombstone-checked query.
    // Loading the fields separately (keyed only by entityVersionId) after the
    // version's `deletedAt IS NULL` check left a TOCTOU window: a tombstone
    // landing between the two reads would still hand a withdrawn version's
    // field content back through the tool.
    const versionRow = await context.scopedDb((tx) =>
      tx.query.entityVersions.findFirst({
        where: {
          id: { eq: versionId },
          entityId: { eq: entityId },
          workspaceId: { eq: workspaceId },
          deletedAt: { isNull: true },
        },
        columns: {
          id: true,
          versionNumber: true,
          stamp: true,
          label: true,
          description: true,
          createdAt: true,
        },
        with: {
          // SAFETY: one version's fields, bounded by LIMITS.propertiesCount via
          // the unique (propertyId, entityVersionId) index.
          fields: { columns: { id: true, propertyId: true, content: true } },
        },
      }),
    );
    if (!versionRow) {
      return notFoundResult("Version not found");
    }
    const { fields: versionFields, ...versionMeta } = versionRow;

    const payload = {
      entityId,
      name: owner.name,
      version: {
        ...versionMeta,
        createdAt: versionRow.createdAt.toISOString(),
        fields: versionFields,
      },
    } satisfies v.InferInput<typeof READ_DOCUMENT_VERSION_PROJECTION>;
    const textFields = runTextFieldSpecs(
      readDocumentVersionDetailTextFieldSpecs(workspaceId),
      payload,
    );
    return { egress: "structured", payload, textFields };
  }

  // Default: current version metadata + field values.
  const currentResult = await Result.gen(() =>
    readEntityByIdHandler({ safeDb: context.safeDb, workspaceId, entityId }),
  );
  if (Result.isError(currentResult)) {
    return internalFailureResult(currentResult.error);
  }
  const current = currentResult.value;
  const processingStates = await loadDocumentProcessingStates({
    context,
    current,
    entityId,
    workspaceId,
  });

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
    contentState: processingStates.contentState,
    searchIndexState: processingStates.searchIndexState,
    ...(versionHistory
      ? {
          versions: versionHistory.versions,
          versionsNextCursor: versionHistory.nextCursor,
        }
      : {}),
  } satisfies v.InferInput<typeof READ_DOCUMENT_DEFAULT_PROJECTION>;

  // Version history carries tenant-authored label/description; payload.versions
  // holds the same entry references runTextFieldSpecs reads from, so the
  // write-back anonymizes the served payload in place, matching the
  // specific-version branch above.
  const textFields = runTextFieldSpecs(
    readDocumentDefaultTextFieldSpecs(workspaceId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

const saveDocumentArgsSchema = v.pipe(
  v.strictObject({
    entity_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("Document entity ID to update; omit to create"),
      ),
    ),
    matter_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "Matter ID to create the entity in; required when creating.",
        ),
      ),
    ),
    name: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(LIMITS.entityNameMaxLength),
        v.description(
          "Display name: required when creating, or the new name when renaming",
        ),
      ),
    ),
    parent_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "Folder entity ID: to place the new entity inside when creating, or to " +
            "move the document into when updating",
        ),
      ),
    ),
    kind: v.optional(
      v.pipe(
        v.picklist(["document", "folder"]),
        v.description(
          "Entity kind to create; defaults to 'document'. Only valid when creating.",
        ),
      ),
    ),
    move_to_root: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Move the document to the matter root (no parent folder). Only valid when updating.",
        ),
      ),
    ),
    version_id: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "Version ID to annotate; required when setting label or description. Only valid when updating.",
        ),
      ),
    ),
    label: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
        v.description(
          "New label for version_id; pass null to clear, empty string is not allowed, omit to leave unchanged",
        ),
      ),
    ),
    description: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1024))),
        v.description(
          "New description for version_id; pass null to clear, empty string is not allowed, omit to leave unchanged",
        ),
      ),
    ),
  }),
  // Creating (no entity_id) requires matter_id and name.
  v.forward(
    v.partialCheck(
      [["entity_id"], ["matter_id"]],
      ({ entity_id, matter_id }) =>
        entity_id !== undefined || matter_id !== undefined,
      "matter_id is required to create a document",
    ),
    ["matter_id"],
  ),
  v.forward(
    v.partialCheck(
      [["entity_id"], ["name"]],
      ({ entity_id, name }) => entity_id !== undefined || name !== undefined,
      "name is required to create a document",
    ),
    ["name"],
  ),
  // matter_id and kind describe the entity to create; neither applies to an
  // update.
  v.forward(
    v.partialCheck(
      [["entity_id"], ["matter_id"]],
      ({ entity_id, matter_id }) =>
        entity_id === undefined || matter_id === undefined,
      "matter_id applies only when creating; omit it when updating a document",
    ),
    ["matter_id"],
  ),
  v.forward(
    v.partialCheck(
      [["entity_id"], ["kind"]],
      ({ entity_id, kind }) => entity_id === undefined || kind === undefined,
      "kind applies only when creating a document",
    ),
    ["kind"],
  ),
  // move_to_root, version_id, label, and description are all update-only edits.
  v.partialCheck(
    [
      ["entity_id"],
      ["move_to_root"],
      ["version_id"],
      ["label"],
      ["description"],
    ],
    ({ entity_id, move_to_root, version_id, label, description }) =>
      entity_id !== undefined ||
      (move_to_root === undefined &&
        version_id === undefined &&
        label === undefined &&
        description === undefined),
    "move_to_root, version_id, label, and description apply to an existing document; pass entity_id",
  ),
  // An update must request at least one mutation; an empty update is a no-op the
  // caller almost certainly did not intend.
  v.partialCheck(
    [
      ["entity_id"],
      ["name"],
      ["parent_id"],
      ["move_to_root"],
      ["version_id"],
      ["label"],
      ["description"],
    ],
    (input) => {
      if (input.entity_id === undefined) {
        return true;
      }
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

type SaveDocumentInput = v.InferOutput<typeof saveDocumentArgsSchema>;

// Create branch of save_document: a new empty document or folder. Reused from
// the former create_document tool.
const createDocumentEntity = async ({
  context,
  input,
}: {
  context: McpRequestContext;
  input: SaveDocumentInput;
}): Promise<
  InternalToolResult<v.InferInput<typeof SAVE_DOCUMENT_PROJECTION>>
> => {
  if (!hasEffectiveAuthority(context, { entity: ["create"] })) {
    return errorResult("Forbidden");
  }

  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: input.matter_id ?? "",
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
        kind: input.kind ?? "document",
        parentId:
          input.parent_id === undefined
            ? null
            : brandPersistedEntityId(input.parent_id),
        name: input.name ?? "",
      },
    }),
  );
  if (Result.isError(created)) {
    return internalFailureResult(created.error);
  }

  return toolDataResult({
    entityId: created.value.entityId,
  } satisfies v.InferInput<typeof SAVE_DOCUMENT_CREATE_PROJECTION>);
};

/**
 * Validate the entities save_document's update branch will touch before any
 * mutation runs, so
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
      return notFoundResult("Target folder not found or not accessible");
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
          deletedAt: { isNull: true },
        },
        columns: { id: true },
      }),
    );
    if (!version) {
      return notFoundResult("Version not found");
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
      return internalFailureResult(labelled.error);
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
      return internalFailureResult(described.error);
    }
  }
  return null;
};

// Update branch of save_document: rename/move/annotate an existing document.
// Reused from the former update_document tool; the caller guarantees entity_id
// is present.
const updateDocumentEntity = async ({
  context,
  input,
}: {
  context: McpRequestContext;
  input: SaveDocumentInput;
}): Promise<
  InternalToolResult<v.InferInput<typeof SAVE_DOCUMENT_PROJECTION>>
> => {
  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return errorResult("Forbidden");
  }

  // Cross-field shape rules (at least one change, parent_id/move_to_root
  // exclusivity, label/description require version_id) are enforced by
  // saveDocumentArgsSchema above; only DB-dependent target validation remains.
  const wantsMove =
    input.parent_id !== undefined || input.move_to_root === true;

  const entityId = brandPersistedEntityId(input.entity_id ?? "");
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
      return internalFailureResult(renamed.error);
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
      return internalFailureResult(moved.error);
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

  return toolDataResult({
    updated: true,
  } satisfies v.InferInput<typeof SAVE_DOCUMENT_UPDATE_PROJECTION>);
};

const handleSaveDocumentTool: TypedMcpToolHandler<
  v.InferInput<typeof SAVE_DOCUMENT_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(saveDocumentArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  // Omit entity_id to create; pass it to update.
  if (input.entity_id === undefined) {
    return await createDocumentEntity({ context, input });
  }
  return await updateDocumentEntity({ context, input });
};

type DocumentVersionUploadTargetResult =
  | {
      status: "ok";
      entityId: SafeId<"entity">;
      workspaceId: SafeId<"workspace">;
    }
  | { status: "error"; response: McpToolResponse };

const resolveDocumentVersionUploadTarget = async ({
  context,
  entityId: rawEntityId,
}: {
  context: McpRequestContext;
  entityId: string;
}): Promise<DocumentVersionUploadTargetResult> => {
  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return { status: "error", response: errorResult("Forbidden") };
  }

  const entityId = brandPersistedEntityId(rawEntityId);
  const owner = await resolveEntityWorkspace({ context, entityId });
  if (owner.status !== "ok") {
    return {
      status: "error",
      response: documentEntityNotAvailable(owner),
    };
  }
  const active = ensureActiveWorkspace({
    context,
    workspaceId: owner.workspaceId,
  });
  if (typeof active !== "string") {
    return { status: "error", response: active };
  }
  return { entityId, status: "ok", workspaceId: owner.workspaceId };
};

const handleUploadDocumentVersionTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(
    UPLOAD_DOCUMENT_VERSION_TOOL_DEFINITION.inputSchemaSource,
    args,
  );
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const target = await resolveDocumentVersionUploadTarget({
    context,
    entityId: parsed.output.entity_id,
  });
  if (target.status === "error") {
    return target.response;
  }

  return await uploadRemoteDocumentVersion({
    context,
    entityId: target.entityId,
    file: parsed.output.file,
    workspaceId: target.workspaceId,
  });
};

const handleOpenDocumentVersionUploadTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(
    OPEN_DOCUMENT_VERSION_UPLOAD_TOOL_DEFINITION.inputSchemaSource,
    args,
  );
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const target = await resolveDocumentVersionUploadTarget({
    context,
    entityId: parsed.output.entity_id,
  });
  if (target.status === "error") {
    return target.response;
  }

  const data = {
    entityId: target.entityId,
    workspaceId: target.workspaceId,
  };
  return toolDataResult(data, {
    primaryText:
      "Choose a file in the upload panel to add a new document version.",
    structuredContent: data,
  });
};

const deleteDocumentArgsSchema = v.strictObject({
  entity_id: uuidInputSchema("Document entity ID to delete"),
  version_id: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.description("Delete only this version instead of the whole document"),
    ),
  ),
  confirm: v.optional(
    v.pipe(
      v.boolean(),
      v.description(
        "Must be true to run this irreversible operation. Set it only after a " +
          "human user has explicitly approved the deletion.",
      ),
    ),
  ),
});

const handleDeleteDocumentTool: TypedMcpToolHandler<
  v.InferInput<typeof DELETED_TRUE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(deleteDocumentArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
    if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
      return errorResult("Forbidden");
    }
    const versionId = brandPersistedEntityVersionId(parsed.output.version_id);
    const deleted = await Result.gen(() =>
      deleteEntityVersionHandler({
        safeDb: context.safeDb,
        workspaceId,
        entityId,
        versionId,
        deletedByUserId: context.userId,
        recordAuditEvent,
      }),
    );
    if (Result.isError(deleted)) {
      return internalFailureResult(deleted.error);
    }
    return toolDataResult({
      deleted: true,
    } satisfies v.InferInput<typeof DELETED_TRUE_PROJECTION>);
  }

  if (!hasEffectiveAuthority(context, { entity: ["delete"] })) {
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
    return internalFailureResult(deleted.error);
  }
  return toolDataResult({
    deleted: true,
  } satisfies v.InferInput<typeof DELETED_TRUE_PROJECTION>);
};

const listPropertiesArgsSchema = v.strictObject({
  matter_id: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("Matter ID to list properties for."),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_LIST_LIMIT),
      v.description("Max properties to return"),
    ),
  ),
  cursor: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(512),
      v.description(
        "Opaque cursor from a previous list_properties call to fetch the next page",
      ),
    ),
  ),
});

const propertyPageCursorCodec = createTimestampIdCursorCodec({
  column: properties.createdAt,
  brandId: brandPersistedPropertyId,
});

const handleListPropertiesTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_PROPERTIES_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    workspace: ["read"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listPropertiesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (!workspaceId) {
    return notFoundResult("Matter not found or not accessible");
  }

  let boundary: ReturnType<typeof propertyPageCursorCodec.decode> = null;
  if (parsed.output.cursor !== undefined) {
    boundary = propertyPageCursorCodec.decode(parsed.output.cursor);
    if (boundary === null) {
      return structuredErrorResult({
        code: "validation_error",
        message: "Invalid cursor",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        hint: "Pass the 'cursor' verbatim as returned by a previous call, or omit it for the first page.",
      });
    }
  }
  const limit = parsed.output.limit ?? DEFAULT_LIST_LIMIT;

  const boundaryCondition = boundary
    ? propertyPageCursorCodec.keysetAfter({
        cursor: boundary,
        direction: "ascending",
        idColumn: properties.id,
      })
    : undefined;

  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        createdAt: propertyPageCursorCodec.cursorValue.as("created_at_cursor"),
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
    cursorForItem: (item) =>
      propertyPageCursorCodec.encode(item.createdAt, item.id),
  });

  const propertyList = page.items.map((property) => ({
    id: property.id,
    name: property.name,
    valueType: property.content.type,
    status: property.status,
    writeMethod: PROPERTY_WRITE_METHODS[property.content.type],
  }));

  const payload = {
    properties: propertyList,
    nextCursor: page.nextCursor,
  } satisfies v.InferInput<typeof LIST_PROPERTIES_PROJECTION>;
  const textFields = runTextFieldSpecs(
    propertyListTextFieldSpecs(workspaceId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

const SET_FIELD_VALUE_TYPE_DESCRIPTION =
  "Value type; must match the property's value type";
const SET_FIELD_VALUE_VALUE_DESCRIPTION =
  "The value: string for text, string or null for single-select, array of " +
  "strings for multi-select, ISO YYYY-MM-DD or null for date, integer for " +
  "int. Null or empty clears the cell.";

const setFieldValueContentSchema = v.variant("type", [
  v.strictObject({
    type: v.pipe(
      v.literal("text"),
      v.description(SET_FIELD_VALUE_TYPE_DESCRIPTION),
    ),
    value: v.pipe(v.string(), v.description(SET_FIELD_VALUE_VALUE_DESCRIPTION)),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("single-select"),
      v.description(SET_FIELD_VALUE_TYPE_DESCRIPTION),
    ),
    value: v.pipe(
      v.nullable(v.string()),
      v.description(SET_FIELD_VALUE_VALUE_DESCRIPTION),
    ),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("multi-select"),
      v.description(SET_FIELD_VALUE_TYPE_DESCRIPTION),
    ),
    value: v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1))),
      v.description(SET_FIELD_VALUE_VALUE_DESCRIPTION),
    ),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("date"),
      v.description(SET_FIELD_VALUE_TYPE_DESCRIPTION),
    ),
    value: v.pipe(
      v.nullable(v.pipe(v.string(), v.isoDate())),
      v.description(SET_FIELD_VALUE_VALUE_DESCRIPTION),
    ),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("int"),
      v.description(SET_FIELD_VALUE_TYPE_DESCRIPTION),
    ),
    value: v.pipe(
      v.number(),
      v.integer(),
      v.description(SET_FIELD_VALUE_VALUE_DESCRIPTION),
    ),
    currency: v.optional(
      v.pipe(
        v.nullable(v.pipe(v.string(), v.length(3))),
        v.description(
          "For int values only: 3-letter ISO currency code, or null",
        ),
      ),
    ),
  }),
]);

const setFieldValueArgsSchema = v.strictObject({
  entity_id: uuidInputSchema("Document entity ID whose cell to set"),
  property_id: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("Property ID, as returned by list_properties"),
  ),
  content: v.pipe(
    setFieldValueContentSchema,
    v.description("The value to set; 'type' must match the property."),
  ),
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

const handleSetFieldValueTool: TypedMcpToolHandler<
  v.InferInput<typeof SET_FIELD_VALUE_PROJECTION>
> = async ({ args, context }) => {
  const hasPermission = hasEffectiveAuthority(context, {
    entity: ["create", "update"],
  });
  if (!hasPermission) {
    return errorResult("Forbidden");
  }

  const rawContent = args["content"];
  if (
    typeof rawContent === "object" &&
    rawContent !== null &&
    "type" in rawContent &&
    rawContent.type === "file"
  ) {
    return structuredErrorResult({
      code: "validation_error",
      message: "File properties cannot be targeted by set_field_value",
      issues: [
        {
          path: "content.type",
          message: "Arbitrary file-property cells are not writable",
        },
      ],
      hint: "To replace the document's primary file, call open_document_version_upload or upload_document_version. These tools do not target an arbitrary property_id.",
    });
  }

  const parsed = v.safeParse(setFieldValueArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  if (!isUuid(parsed.output.property_id)) {
    return structuredErrorResult({
      code: "validation_error",
      issues: [{ path: "property_id", message: "property_id must be a UUID" }],
      message: "Invalid input: property_id must be a UUID",
    });
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
    return internalFailureResult(result.error);
  }

  return toolDataResult(
    {} satisfies v.InferInput<typeof SET_FIELD_VALUE_PROJECTION>,
  );
};

export const DOCUMENT_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    annotations: {
      title: "List documents",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List the documents and folders in a matter. Use 'flat' mode to " +
      "enumerate every document and folder in the matter, or 'children' " +
      "mode to walk the folder tree one level at a time (pass parent_id to " +
      "list a folder's direct children, or omit it for the matter root). " +
      "Returns each entity's id, name, kind (document or folder), and " +
      "parentId. Read a " +
      "document's metadata, fields, or versions with read_document.",
    inputSchema: listDocumentsArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The mode/parent_id dependency remains authoritative in the runtime schema.",
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [DOCUMENT_LIST_TEXT_FIELD_PATH],
    },
    name: "list_documents",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Read document",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read a document's metadata and field values by entity ID. By default " +
      "returns the current version's name, kind, and field/property values. " +
      "The default response also reports contentState and searchIndexState, " +
      "including an actionable remediation or escalation requirement when " +
      "document text processing is required. " +
      "Pass version_id to inspect a specific version instead. Pass version_id " +
      "and compare_with_version_id to get a plain-text line diff between two " +
      "versions. Pass include_versions to also return the version history. To " +
      "read the document's extracted text content, use read_content_across_matters.",
    inputSchema: readDocumentArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The compare_with_version_id/version_id dependency remains authoritative in the runtime schema.",
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: READ_DOCUMENT_TEXT_FIELD_PATHS,
    },
    name: "read_document",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    description:
      "Create a document or folder, or update an existing one. Omit entity_id " +
      "to create: pass matter_id and name, optionally a parent_id folder " +
      "and kind ('document' by default, or 'folder'). Creating makes an empty named " +
      "entity; uploading file content is a separate step. Pass entity_id to " +
      "update: set name to rename; parent_id to move it into a folder or " +
      "move_to_root to move it to the matter root; version_id with label " +
      "and/or description to annotate a version. An update needs at least one change. " +
      "Returns the entity ID.",
    inputSchema: saveDocumentArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The create/update field dependencies remain authoritative in the runtime schema.",
    },
    annotations: {
      title: "Save document",
      idempotentHint: false,
      openWorldHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_document",
    scope: "stella:documents_write",
  }),
  UPLOAD_DOCUMENT_VERSION_TOOL_DEFINITION,
  OPEN_DOCUMENT_VERSION_UPLOAD_TOOL_DEFINITION,
  defineValibotMcpTool({
    annotations: {
      title: "Delete document",
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Delete a document and all its versions, or delete a single version when " +
      "version_id is provided (the current version is promoted to the next " +
      "latest; the only remaining version cannot be deleted). This is " +
      "irreversible.",
    inputSchema: deleteDocumentArgsSchema,
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "delete_document",
    scope: "stella:documents_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "List properties",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List the property (column) definitions of a matter. Returns each " +
      "property's id, name, value type (text, single-select, multi-select, " +
      "date, int, or file), status, and writeMethod. Use set_field_value for " +
      "scalar properties. Arbitrary file-property cells are not writable; document " +
      "upload/version tools replace only a document's primary file.",
    inputSchema: listPropertiesArgsSchema,
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [PROPERTY_LIST_TEXT_FIELD_PATH],
    },
    name: "list_properties",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    description:
      "Set a document's value for a property (a cell in the matter's table). " +
      "Pass the document entity_id, the property_id (from list_properties), and " +
      "a content object whose 'type' matches the property's value type: text " +
      "(value: string), single-select (value: string or null), multi-select " +
      "(value: array of strings), date (value: ISO YYYY-MM-DD or null), or int " +
      "(value: integer, optional currency: 3-letter ISO code). An empty value " +
      "clears the cell.",
    inputSchema: setFieldValueArgsSchema,
    // Not idempotent: upsertFieldHandler unconditionally deletes/reinserts and
    // reindexes the cell and records a fresh audit event + updatedAt bump on
    // every call, so a repeat with identical args has an observable additional
    // effect (a duplicate audit entry) in this compliance context.
    annotations: {
      title: "Set field value",
      idempotentHint: false,
      openWorldHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "set_field_value",
    scope: "stella:documents_write",
  }),
] as const satisfies readonly McpToolDefinition[];

export const DOCUMENT_TOOL_HANDLERS = {
  delete_document: handleDeleteDocumentTool,
  list_documents: handleListDocumentsTool,
  list_properties: handleListPropertiesTool,
  [DOCUMENT_VERSION_UPLOAD_TRANSPORT.pickerToolName]:
    handleOpenDocumentVersionUploadTool,
  read_document: handleReadDocumentTool,
  save_document: handleSaveDocumentTool,
  [DOCUMENT_VERSION_UPLOAD_TRANSPORT.toolName]: handleUploadDocumentVersionTool,
  set_field_value: handleSetFieldValueTool,
} satisfies Record<DocumentToolName, McpToolHandler>;

export const DOCUMENT_TOOL_SET = defineMcpToolSet(
  DOCUMENT_TOOL_DEFINITIONS,
  DOCUMENT_TOOL_HANDLERS,
);
