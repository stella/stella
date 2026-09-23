/**
 * A reader's highlights and comments on case-law decisions and statutes, for
 * an agent: read them, place new ones, change or remove its user's own.
 *
 * The reader stores a mark as offsets into a block's text, measured by the
 * browser from a selection. An agent has no selection; it has the anchors the
 * document text prints and the words it read there. `create_reader_annotation`
 * takes that pair and places the mark on the document server-side, so a mark
 * an agent leaves is the same record the reader would have written and shows
 * up in the reader's margin like any other.
 */

import { panic, Result } from "better-result";
import { CryptoHasher } from "bun";
import * as v from "valibot";

import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_MAX_SPANS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_TARGET_TYPES,
  READER_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/legal-reader-annotations";

import { createReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/create";
import { deleteReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/delete";
import { readAnnotationTargetBlocks } from "@/api/handlers/legal-reader/annotations/document-blocks";
import { listReaderAnnotationsHandler } from "@/api/handlers/legal-reader/annotations/list";
import { locatePassages } from "@/api/handlers/legal-reader/annotations/locate.logic";
import type {
  CreateAnnotationBody,
  UpdateAnnotationBody,
} from "@/api/handlers/legal-reader/annotations/schema";
import { updateReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/update";
import {
  CREATE_READER_ANNOTATION_PROJECTION,
  DELETED_TRUE_PROJECTION,
  LIST_READER_ANNOTATIONS_PROJECTION,
  UPDATE_READER_ANNOTATION_PROJECTION,
} from "@/api/lib/chat/projections";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedLegalReaderAnnotationId } from "@/api/lib/safe-id-boundaries";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type {
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  cursorInput,
  errorResult,
  internalFailureResult,
  notFoundResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  uuidInputSchema,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";

const TARGET_ID_DESCRIPTION =
  "The document: for a decision, its decisionId (read_case_law_decision, " +
  "search_case_law); for a statute, the documentId of the consolidated " +
  "version (read_statute). A statute's marks belong to that one version.";

const targetArgs = {
  target_type: v.pipe(
    v.picklist(READER_ANNOTATION_TARGET_TYPES),
    v.description("decision (case law) or statute (legislation)."),
  ),
  target_id: uuidInputSchema(TARGET_ID_DESCRIPTION),
};

const colorSchema = v.pipe(
  v.picklist(READER_ANNOTATION_COLORS),
  v.description("Highlight colour."),
);

const styleSchema = v.pipe(
  v.picklist(READER_ANNOTATION_STYLES),
  v.description(
    "How the highlight is drawn: highlight (a background), underline, " +
      "squiggly, or strikethrough.",
  ),
);

const visibilitySchema = v.pipe(
  v.picklist(READER_ANNOTATION_VISIBILITIES),
  v.description(
    "private (only the user sees it) or shared (visible to the whole " +
      "organization).",
  ),
);

const commentBodySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(READER_ANNOTATION_BODY_MAX_LENGTH),
  v.description("The comment's words."),
);

// --- list_reader_annotations --------------------------------------------------

const listArgsSchema = nullAsAbsent(
  v.strictObject({
    ...targetArgs,
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.readerAnnotationsPageSizeMax),
        v.description(
          "Max rows to read (a mark over several paragraphs is several rows).",
        ),
      ),
    ),
    cursor: cursorInput({
      description:
        "Opaque cursor from a previous list_reader_annotations call to fetch the next page",
    }),
  }),
);

type ListedMark = v.InferInput<
  typeof LIST_READER_ANNOTATIONS_PROJECTION
>["annotations"][number];

const handleListTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_READER_ANNOTATIONS_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { workspace: ["read"] })) {
    return errorResult("Forbidden");
  }
  const parsed = v.safeParse(listArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, limit, target_id, target_type } = parsed.output;

  const listed = await Result.gen(() =>
    listReaderAnnotationsHandler({
      organizationId: context.organizationId,
      query: {
        targetId: target_id,
        targetType: target_type,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
      safeDb: context.safeDb,
      userId: context.userId,
    }),
  );
  if (Result.isError(listed)) {
    return internalFailureResult(listed.error);
  }

  // One entry per mark, as the reader shows it: the rows of a passage over
  // several paragraphs share a group and read as one.
  const marks = new Map<string, ListedMark>();
  for (const row of listed.value.items) {
    const key = row.groupId ?? row.id;
    const passage = { anchor: row.blockAnchorId, quote: row.quote };
    const existing = marks.get(key);
    if (existing !== undefined) {
      existing.passages.push(passage);
      existing.body ??= row.body;
      continue;
    }
    marks.set(key, {
      annotationId: row.id,
      kind: row.kind,
      color: row.color,
      style: row.style,
      body: row.body,
      visibility: row.visibility,
      mine: row.mine,
      authorName: row.authorName,
      createdAt: row.createdAt.toISOString(),
      passages: [passage],
    });
  }

  return toolDataResult({
    annotations: [...marks.values()],
    nextCursor: listed.value.nextCursor,
  } satisfies v.InferInput<typeof LIST_READER_ANNOTATIONS_PROJECTION>);
};

// --- create_reader_annotation -------------------------------------------------

const markSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("highlight"),
    color: v.optional(colorSchema, "yellow"),
    style: v.optional(styleSchema, "highlight"),
  }),
  v.strictObject({
    kind: v.literal("comment"),
    body: commentBodySchema,
  }),
]);

const passageSchema = v.strictObject({
  anchor: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.description(
      "The block anchor the document text prints in square brackets, " +
        "without the brackets (e.g. p-12, par_9).",
    ),
  ),
  quote: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(READER_ANNOTATION_QUOTE_MAX_LENGTH),
    v.description(
      "The words to mark, copied from that block. Differences in whitespace " +
        "are tolerated; the words must occur exactly once in the block.",
    ),
  ),
});

const createArgsSchema = nullAsAbsent(
  v.strictObject({
    ...targetArgs,
    mark: v.pipe(
      markSchema,
      v.description(
        "What to leave: { kind: highlight, color?, style? } or " +
          "{ kind: comment, body }.",
      ),
    ),
    passages: v.pipe(
      v.array(passageSchema),
      v.minLength(1),
      v.maxLength(READER_ANNOTATION_MAX_SPANS),
      v.description(
        "Where the mark sits: one passage per paragraph it covers, in " +
          "document order. Several passages make one mark.",
      ),
    ),
    visibility: v.optional(visibilitySchema),
  }),
);

const UUID_HEX_LENGTH = 32;
const UUID_VARIANT_DIGITS = ["8", "9", "a", "b"] as const;

/**
 * The same request always names the same mark, so a retried call replays
 * the stored one instead of drawing it twice. A digest of everything the
 * mark is, shaped as a UUID; the create handler compares the stored rows
 * with the request before it treats a present id as a replay.
 */
const createRequestIdFor = (userId: string, request: unknown) => {
  const hex = new CryptoHasher("sha256")
    .update(JSON.stringify([userId, request]))
    .digest("hex")
    .slice(0, UUID_HEX_LENGTH);
  // Version 8 (custom) and the RFC 9562 variant (10xx: 8, 9, a or b).
  const variant =
    UUID_VARIANT_DIGITS[Number.parseInt(hex.charAt(16), 16) % 4] ?? "8";
  const versioned = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return brandPersistedLegalReaderAnnotationId(
    `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`,
  );
};

const handleCreateTool: TypedMcpToolHandler<
  v.InferInput<typeof CREATE_READER_ANNOTATION_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { legalReaderAnnotation: ["create"] })) {
    return errorResult("Forbidden");
  }
  const parsed = v.safeParse(createArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { mark, passages, target_id, target_type, visibility } = parsed.output;

  const document = await Result.tryPromise(
    async () =>
      await readAnnotationTargetBlocks({
        targetId: target_id,
        targetType: target_type,
      }),
  );
  if (Result.isError(document)) {
    return internalFailureResult(document.error);
  }
  switch (document.value.status) {
    case "not_found":
      return notFoundResult(
        `No published ${target_type} has id ${target_id}`,
        target_type === "decision"
          ? "Pass the decisionId from read_case_law_decision or search_case_law."
          : "Pass the documentId of the consolidated version from read_statute.",
      );
    case "withheld":
      return structuredErrorResult({
        code: "permission_denied",
        message:
          "This document's source does not permit derived AI use, so an agent cannot mark its text.",
        hint: "Tell the user; they can highlight or comment on it in the reader themselves.",
      });
    case "unstructured":
      return structuredErrorResult({
        code: "validation_error",
        message:
          "This document is stored as flat text without anchored blocks, so a mark cannot be placed on it.",
        hint: "Tell the user; they can highlight or comment on it in the reader themselves.",
      });
    case "available":
      break;
    default:
      document.value satisfies never;
      return panic("Unhandled annotation target state");
  }

  const located = locatePassages(document.value.blocks, passages);
  if (located.status === "rejected") {
    return structuredErrorResult({
      code: "validation_error",
      message: "Some passages could not be placed on the document",
      hint:
        "Correct each listed passage and resend the whole call. Anchors and " +
        "wording come from the document text (the chat's open document, " +
        "read_case_law_decision, or read_statute_provisions).",
      issues: located.issues.map(({ code, message, passageIndex }) => ({
        path: `passages.${String(passageIndex)}`,
        message: `${code}: ${message}`,
      })),
    });
  }

  const shared = {
    requestId: createRequestIdFor(context.userId, {
      mark,
      spans: located.spans,
      target_id,
      target_type,
      visibility,
    }),
    spans: located.spans,
    targetId: target_id,
    targetType: target_type,
    visibility: visibility ?? "private",
  } as const;
  const body: CreateAnnotationBody =
    mark.kind === "highlight"
      ? { ...shared, kind: "highlight", color: mark.color, style: mark.style }
      : { ...shared, kind: "comment", body: mark.body };

  const created = await Result.gen(() =>
    createReaderAnnotationHandler({
      body,
      organizationId: context.organizationId,
      recordAuditEvent: context.recordAuditEvent,
      safeDb: context.safeDb,
      userId: context.userId,
    }),
  );
  if (Result.isError(created)) {
    return internalFailureResult(created.error);
  }

  return toolDataResult({
    annotationId: created.value.id,
    passages: located.spans.map((span) => ({
      anchor: span.blockAnchorId,
      quote: span.quote,
    })),
  } satisfies v.InferInput<typeof CREATE_READER_ANNOTATION_PROJECTION>);
};

// --- update_reader_annotation -------------------------------------------------

const changeSchema = v.variant("type", [
  v.strictObject({ type: v.literal("body"), body: commentBodySchema }),
  v.strictObject({ type: v.literal("color"), color: colorSchema }),
  v.strictObject({ type: v.literal("style"), style: styleSchema }),
  v.strictObject({
    type: v.literal("visibility"),
    visibility: visibilitySchema,
  }),
]);

const updateArgsSchema = nullAsAbsent(
  v.strictObject({
    annotation_id: uuidInputSchema(
      "The mark to change: annotationId from list_reader_annotations, or the mark id the chat lists beside the user's marks.",
    ),
    change: v.pipe(
      changeSchema,
      v.description(
        "One change: { type: body, body } rewrites a comment; { type: color, " +
          "color } and { type: style, style } restyle a highlight; { type: " +
          "visibility, visibility } shares or unshares either.",
      ),
    ),
  }),
);

const toHandlerChange = (
  change: v.InferOutput<typeof changeSchema>,
): UpdateAnnotationBody => {
  switch (change.type) {
    case "body":
      return { change: "body", body: change.body };
    case "color":
      return { change: "color", color: change.color };
    case "style":
      return { change: "style", style: change.style };
    case "visibility":
      return { change: "visibility", visibility: change.visibility };
    default:
      change satisfies never;
      return panic(`Unhandled annotation change: ${String(change)}`);
  }
};

const handleUpdateTool: TypedMcpToolHandler<
  v.InferInput<typeof UPDATE_READER_ANNOTATION_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { legalReaderAnnotation: ["update"] })) {
    return errorResult("Forbidden");
  }
  const parsed = v.safeParse(updateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const annotationId = brandPersistedLegalReaderAnnotationId(
    parsed.output.annotation_id,
  );

  const updated = await Result.gen(() =>
    updateReaderAnnotationHandler({
      annotationId,
      change: toHandlerChange(parsed.output.change),
      organizationId: context.organizationId,
      recordAuditEvent: context.recordAuditEvent,
      safeDb: context.safeDb,
      userId: context.userId,
    }),
  );
  if (Result.isError(updated)) {
    return internalFailureResult(updated.error);
  }
  return toolDataResult({
    annotationId,
    updated: true,
  } satisfies v.InferInput<typeof UPDATE_READER_ANNOTATION_PROJECTION>);
};

// --- delete_reader_annotation -------------------------------------------------

const deleteArgsSchema = nullAsAbsent(
  v.strictObject({
    annotation_id: uuidInputSchema(
      "The mark to delete: annotationId from list_reader_annotations, or the mark id the chat lists beside the user's marks.",
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
  }),
);

const handleDeleteTool: TypedMcpToolHandler<
  v.InferInput<typeof DELETED_TRUE_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { legalReaderAnnotation: ["delete"] })) {
    return errorResult("Forbidden");
  }
  const parsed = v.safeParse(deleteArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }

  const deleted = await Result.gen(() =>
    deleteReaderAnnotationHandler({
      annotationId: brandPersistedLegalReaderAnnotationId(
        parsed.output.annotation_id,
      ),
      organizationId: context.organizationId,
      recordAuditEvent: context.recordAuditEvent,
      safeDb: context.safeDb,
      userId: context.userId,
    }),
  );
  if (Result.isError(deleted)) {
    return internalFailureResult(deleted.error);
  }
  return toolDataResult({
    deleted: true,
  } satisfies v.InferInput<typeof DELETED_TRUE_PROJECTION>);
};

// --- registry -------------------------------------------------------------------

const MARK_OWNERSHIP =
  "Only the user's own marks can be changed; a colleague's shared mark reads as not found.";

const READER_ANNOTATION_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    annotations: {
      title: "List reader annotations",
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List the highlights and comments on one case-law decision or one " +
      "statute version that the user can see: their own, and those " +
      "colleagues shared. Each mark lists the passages it covers by block " +
      "anchor and quote, oldest first.",
    inputSchema: listArgsSchema,
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [
        "annotations[].passages[].quote",
        "annotations[].body",
        "annotations[].authorName",
      ],
    },
    name: "list_reader_annotations",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Create reader annotation",
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description:
      "Highlight or comment on a passage of a case-law decision or a statute " +
      "version, as the user. Name each paragraph by the anchor the document " +
      "text prints in square brackets and quote the words to mark; the mark " +
      "appears in the user's reader. Private unless visibility is shared. " +
      "Resending the same call returns the mark it already made.",
    inputSchema: createArgsSchema,
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "create_reader_annotation",
    scope: "stella:knowledge_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Update reader annotation",
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: `Change one of the user's highlights or comments: a comment's words, a highlight's colour or style, or who sees it. ${MARK_OWNERSHIP}`,
    inputSchema: updateArgsSchema,
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "update_reader_annotation",
    scope: "stella:knowledge_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Delete reader annotation",
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    description: `Permanently delete one of the user's highlights or comments, every passage of it. ${MARK_OWNERSHIP}`,
    inputSchema: deleteArgsSchema,
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    destructiveBehavior: { type: "always" },
    name: "delete_reader_annotation",
    scope: "stella:knowledge_write",
  }),
] as const satisfies readonly McpToolDefinition[];

type ReaderAnnotationToolName =
  (typeof READER_ANNOTATION_TOOL_DEFINITIONS)[number]["name"];

export const READER_ANNOTATION_TOOL_HANDLERS = {
  create_reader_annotation: handleCreateTool,
  delete_reader_annotation: handleDeleteTool,
  list_reader_annotations: handleListTool,
  update_reader_annotation: handleUpdateTool,
} satisfies Record<ReaderAnnotationToolName, McpToolHandler>;

export const READER_ANNOTATION_TOOL_SET = defineMcpToolSet(
  READER_ANNOTATION_TOOL_DEFINITIONS,
  READER_ANNOTATION_TOOL_HANDLERS,
  {
    create_reader_annotation: defineChatProjectionMcpToolOutput(
      CREATE_READER_ANNOTATION_PROJECTION,
    ),
    delete_reader_annotation: defineChatProjectionMcpToolOutput(
      DELETED_TRUE_PROJECTION,
    ),
    list_reader_annotations: defineChatProjectionMcpToolOutput(
      LIST_READER_ANNOTATIONS_PROJECTION,
    ),
    update_reader_annotation: defineChatProjectionMcpToolOutput(
      UPDATE_READER_ANNOTATION_PROJECTION,
    ),
  },
);
