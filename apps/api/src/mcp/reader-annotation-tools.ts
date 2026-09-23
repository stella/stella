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
import type { ReaderAnnotationTargetType } from "@stll/api-contract/legal-reader-annotations";
import type { Block } from "@stll/legal-ast/document-ast";

import { createReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/create";
import { deleteReaderAnnotationHandler } from "@/api/handlers/legal-reader/annotations/delete";
import { resolveAnnotationTarget } from "@/api/handlers/legal-reader/annotations/document-blocks";
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
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  InternalToolErrorResult,
  McpTextFieldSpec,
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

const TARGET_REFUSAL_HINT =
  "Tell the user; they can highlight or comment on it in the reader themselves.";

type TargetAccessResult =
  | { status: "available"; readBlocks: () => Promise<readonly Block[]> }
  | { status: "refused"; result: InternalToolErrorResult };

/**
 * The document gate both the read and the writes pass: a mark quotes its
 * document, so a document an agent may not read is one whose marks it may
 * not read either.
 */
const resolveTargetForAgent = async ({
  context,
  targetId,
  targetType,
}: {
  context: McpRequestContext;
  targetId: string;
  targetType: ReaderAnnotationTargetType;
}): Promise<TargetAccessResult> => {
  const resolve =
    context.testDependencies?.resolveAnnotationTarget ??
    resolveAnnotationTarget;
  const access = await Result.tryPromise(
    async () => await resolve({ targetId, targetType }),
  );
  if (Result.isError(access)) {
    return { status: "refused", result: internalFailureResult(access.error) };
  }
  switch (access.value.status) {
    case "available":
      return access.value;
    case "not_found":
      return {
        status: "refused",
        result: notFoundResult(
          `No published ${targetType} has id ${targetId}`,
          targetType === "decision"
            ? "Pass the decisionId from read_case_law_decision or search_case_law."
            : "Pass the documentId of the consolidated version from read_statute.",
        ),
      };
    case "withheld":
      return {
        status: "refused",
        result: structuredErrorResult({
          code: "permission_denied",
          message:
            "This document's source does not permit derived AI use, so an agent cannot read or write marks on it.",
          hint: TARGET_REFUSAL_HINT,
        }),
      };
    default:
      access.value satisfies never;
      return panic("Unhandled annotation target access");
  }
};

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

type ListedMarks = { annotations: readonly ListedMark[] };

/**
 * The tenant-authored text a listing carries: the quoted passages (the
 * public document's words, but chosen by a reader), comment bodies, and
 * author names. The anonymized surface redacts exactly these, and the
 * tool's declared `textFields` are derived from the same list.
 */
const readerAnnotationTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<ListedMarks>[] => [
  defineTextFieldSpec({
    path: "annotations[].passages[].quote",
    items: (payload: ListedMarks) =>
      payload.annotations.flatMap((mark) => mark.passages),
    scope: () => organizationId,
    read: (passage) => passage.quote,
    apply: (passage, value) => {
      passage.quote = value;
    },
  }),
  defineTextFieldSpec({
    path: "annotations[].body",
    items: (payload: ListedMarks) => payload.annotations,
    scope: () => organizationId,
    read: (mark) => mark.body,
    apply: (mark, value) => {
      mark.body = value;
    },
  }),
  defineTextFieldSpec({
    path: "annotations[].authorName",
    items: (payload: ListedMarks) => payload.annotations,
    scope: () => organizationId,
    read: (mark) => mark.authorName,
    apply: (mark, value) => {
      mark.authorName = value;
    },
  }),
];

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

  const target = await resolveTargetForAgent({
    context,
    targetId: target_id,
    targetType: target_type,
  });
  if (target.status === "refused") {
    return target.result;
  }

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

  const payload = {
    annotations: [...marks.values()],
    nextCursor: listed.value.nextCursor,
  } satisfies v.InferInput<typeof LIST_READER_ANNOTATIONS_PROJECTION>;
  return {
    egress: "structured",
    payload,
    textFields: runTextFieldSpecs(
      readerAnnotationTextFieldSpecs(context.organizationId),
      payload,
    ),
  };
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
  anchor: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(64),
      v.description(
        "The block anchor the document text prints in square brackets, " +
          "without the brackets (e.g. p-12, par_9). Omit it to search the " +
          "whole document; an ambiguous quote's error names the candidates.",
      ),
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
const createRequestIdFor = ({
  organizationId,
  request,
  userId,
}: {
  organizationId: string;
  request: unknown;
  userId: string;
}) => {
  const hex = new CryptoHasher("sha256")
    .update(JSON.stringify([organizationId, userId, request]))
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

  const target = await resolveTargetForAgent({
    context,
    targetId: target_id,
    targetType: target_type,
  });
  if (target.status === "refused") {
    return target.result;
  }
  const blocks = await Result.tryPromise(target.readBlocks);
  if (Result.isError(blocks)) {
    return internalFailureResult(blocks.error);
  }
  if (blocks.value.length === 0) {
    return structuredErrorResult({
      code: "validation_error",
      message:
        "This document is stored as flat text without anchored blocks, so a mark cannot be placed on it.",
      hint: TARGET_REFUSAL_HINT,
    });
  }

  const located = locatePassages(blocks.value, passages);
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

  // The id is the primary key, unique across organizations, so the
  // organization is part of it; visibility is hashed as stored, so an omitted
  // one and "private" name the same mark.
  const storedVisibility = visibility ?? "private";
  const shared = {
    requestId: createRequestIdFor({
      organizationId: context.organizationId,
      request: {
        mark,
        spans: located.spans,
        target_id,
        target_type,
        visibility: storedVisibility,
      },
      userId: context.userId,
    }),
    spans: located.spans,
    targetId: target_id,
    targetType: target_type,
    visibility: storedVisibility,
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
      textFields: deriveTextFieldPaths(readerAnnotationTextFieldSpecs("")),
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
      "version, as the user. Quote the words to mark, one passage per " +
      "paragraph, with its anchor when the document text shows one; the mark " +
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
