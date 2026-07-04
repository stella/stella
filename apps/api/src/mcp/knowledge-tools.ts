import { Result } from "better-result";
import * as v from "valibot";

import { roles } from "@stll/permissions";

import { listCategoriesHandler } from "@/api/handlers/clauses/categories";
import { createClauseHandler } from "@/api/handlers/clauses/create";
import { deleteClauseHandler } from "@/api/handlers/clauses/delete";
import {
  getClauseHandler,
  getClauseVersionHandler,
  listClausesHandler,
} from "@/api/handlers/clauses/read";
import type { ClauseBody } from "@/api/handlers/clauses/types";
import { isClauseBody } from "@/api/handlers/clauses/types";
import { updateClauseHandler } from "@/api/handlers/clauses/update";
import { materializePlaybookRun } from "@/api/handlers/playbooks/materialize-run";
import {
  getPlaybookDefinitionHandler,
  listPlaybookDefinitionsHandler,
} from "@/api/handlers/playbooks/read";
import { captureError } from "@/api/lib/analytics";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedClauseCategoryId,
  brandPersistedClauseId,
  brandPersistedClauseVersionId,
  brandPersistedPlaybookDefinitionId,
} from "@/api/lib/safe-id-boundaries";
import { startWorkflow } from "@/api/lib/workflow-queue";
import type { McpRequestContext } from "@/api/mcp/context";
import type {
  McpStructuredTextField,
  McpToolDefinition,
  McpToolHandler,
} from "@/api/mcp/tool-types";
import {
  ensureActiveWorkspace,
  enumProp,
  errorResult,
  intProp,
  nullableStringProp,
  stringProp,
  textResult,
} from "@/api/mcp/tool-utils";

type KnowledgeToolName =
  | "list_clauses"
  | "save_clause"
  | "delete_clause"
  | "list_playbooks"
  | "run_playbook";

/** List item kinds accepted on a clause paragraph. Mirrors ClauseListKind. */
const CLAUSE_LIST_KINDS = ["bullet", "ordered"] as const;

/** Block directive kinds accepted on a clause paragraph. Mirrors shared-schemas. */
const CLAUSE_DIRECTIVE_KINDS = [
  "if",
  "elseif",
  "else",
  "endif",
  "each",
  "endeach",
] as const;

/** One inline formatting run inside a clause paragraph. */
const clauseRunItemSchema = {
  type: "object",
  properties: {
    text: stringProp("Run text"),
    bold: { type: "boolean", description: "Render the run bold" },
    italic: { type: "boolean", description: "Render the run italic" },
  },
  required: ["text"],
} as const;

/** One clause body paragraph in the save_clause `body` array. */
const clauseParagraphItemSchema = {
  type: "object",
  properties: {
    text: stringProp("Paragraph plain text"),
    style: stringProp("Optional paragraph style name"),
    level: intProp("Optional heading/outline level"),
    runs: {
      type: "array",
      description:
        "Optional inline formatting runs whose text concatenates to the paragraph",
      items: clauseRunItemSchema,
    },
    listKind: enumProp(
      "List item kind when the paragraph is a list item",
      CLAUSE_LIST_KINDS,
    ),
    listLevel: intProp("0-based list nesting depth for a list item"),
    isDirective: {
      type: "boolean",
      description: "Whether the paragraph is a template directive marker",
    },
    directiveKind: enumProp(
      "Directive kind when isDirective is set",
      CLAUSE_DIRECTIVE_KINDS,
    ),
    directiveExpression: stringProp(
      "Directive expression for an if/each directive",
    ),
  },
  required: ["text"],
} as const;

const clauseBodyProp = {
  type: "array",
  description:
    "Ordered clause body paragraphs; required when creating. Each paragraph " +
    "carries text and optional formatting.",
  items: clauseParagraphItemSchema,
} as const;

export const KNOWLEDGE_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the clause library for this organization, or read one clause in " +
      "detail. Pass clause_id to get a clause's body, description, usage notes, " +
      "variants, and version history; add version_id to read one version's " +
      "body. Otherwise list clauses (newest first), optionally filtered by " +
      "category_id or a text query, and set include_categories to also return " +
      "the category tree. Returns each clause's id, title, category, language, " +
      "and current version.",
    inputSchema: {
      type: "object",
      properties: {
        clause_id: stringProp("Clause id to read in detail; omit to list"),
        version_id: stringProp(
          "With clause_id, return this version's body instead of the current clause",
        ),
        category_id: stringProp(
          "List only clauses filed under this category (list mode)",
        ),
        query: stringProp(
          "Filter clauses by a text query over title and body (list mode)",
        ),
        include_categories: {
          type: "boolean",
          description:
            "Also return the organization's clause categories (list mode)",
        },
        limit: intProp("Max clauses to return", {
          min: 1,
          max: LIMITS.clausesPageSizeMax,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_clauses call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    anonymized: {
      exposure: "anonymize",
      textFields: [
        "clauses[].title",
        "clauses[].description",
        "categories[].name",
        "categories[].description",
        "clause.title",
        "clause.description",
        "clause.usageNotes",
        "clause.body[].text",
        "clause.variants[].label",
        "clause.variants[].body[].text",
        "version.body[].text",
      ],
    },
    name: "list_clauses",
    scope: "stella:read",
  },
  {
    description:
      "Create or update a clause in the organization's clause library. Omit " +
      "clause_id to create (title and body required); pass clause_id to update. " +
      "body is an ordered array of paragraphs, each with text and optional " +
      "formatting. category_id, language, description, usage_notes, and metadata " +
      "accept null to clear them on update. Set snapshot_version true on an " +
      "update to also append a version snapshot of the body. Returns the clause id.",
    inputSchema: {
      type: "object",
      properties: {
        clause_id: stringProp("Clause id to update; omit to create"),
        title: stringProp("Clause title; required when creating", {
          maxLength: 256,
        }),
        body: clauseBodyProp,
        category_id: nullableStringProp(
          "Category id to file the clause under; pass null to clear",
        ),
        language: nullableStringProp(
          "BCP-47 language tag for the clause; pass null to clear",
          { maxLength: 10 },
        ),
        description: nullableStringProp(
          "Short clause description; pass null to clear",
          { maxLength: 2000 },
        ),
        usage_notes: nullableStringProp(
          "Guidance on when to use the clause; pass null to clear",
          { maxLength: 2000 },
        ),
        metadata: {
          type: ["object", "null"],
          description: "Free-form metadata object; pass null to clear",
          additionalProperties: true,
        },
        snapshot_version: {
          type: "boolean",
          description:
            "When updating, also append a version snapshot of the body",
        },
      },
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_clause",
    scope: "stella:knowledge_write",
  },
  {
    annotations: { destructiveHint: true },
    description:
      "Permanently delete a clause and all its variants and versions from the " +
      "organization's clause library. This is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        clause_id: stringProp("Clause id to delete"),
      },
      required: ["clause_id"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "delete_clause",
    scope: "stella:knowledge_write",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "List the review playbooks in this organization, or read one in detail. " +
      "Pass playbook_id to get a playbook's positions (the issues it reviews, " +
      "their questions, standards, and grading rules), scope, and description. " +
      "Otherwise list playbooks (newest first). Returns each playbook's id, " +
      "name, and description.",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: stringProp(
          "Playbook id to read in detail; omit to list playbooks",
        ),
        limit: intProp("Max playbooks to return", {
          min: 1,
          max: LIMITS.playbookDefinitionsPageSizeMax,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous list_playbooks call to fetch the next page",
          { maxLength: 512 },
        ),
      },
    },
    anonymized: {
      exposure: "anonymize",
      textFields: [
        "items[].name",
        "items[].description",
        "playbook.name",
        "playbook.description",
        "playbook.positions.items[].issue",
        "playbook.positions.items[].ask.question",
        "playbook.positions.items[].guidance",
        "playbook.positions.items[].standard.preferred",
        "playbook.positions.items[].standard.fallbacks[].text",
      ],
    },
    name: "list_playbooks",
    scope: "stella:read",
  },
  {
    description:
      "Run a review playbook over a matter's documents. Materializes the " +
      "playbook's extraction and verdict columns onto the matter's table and " +
      "starts the AI review; findings populate asynchronously. Pass matter_id " +
      "and playbook_id. Returns the number of columns queued for review.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace id to run the playbook over"),
        playbook_id: stringProp("Playbook id to run"),
      },
      required: ["matter_id", "playbook_id"],
    },
    anonymized: { exposure: "excluded", reason: "write" },
    name: "run_playbook",
    scope: "stella:knowledge_write",
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
 * null (org-scoped); the workspace-scoped playbook run builds its EXECUTE event
 * without a workspaceId, so inject it per event (an event that sets its own wins).
 */
const bindWorkspaceRecorder =
  (
    context: McpRequestContext,
    workspaceId: SafeId<"workspace">,
  ): AuditRecorder =>
  async (tx, event) => {
    const events: AuditEvent[] = Array.isArray(event) ? event : [event];
    for (const e of events) {
      if (e.workspaceId === undefined) {
        e.workspaceId = workspaceId;
      }
    }
    await context.recordAuditEvent(tx, events);
  };

/**
 * Prefer a cross-field (`partial_check`) validation message when present,
 * falling back to the hand-written shape hint for structural failures.
 */
const crossFieldOrGeneric = (
  issues: readonly v.BaseIssue<unknown>[],
  genericMessage: string,
): string =>
  issues.find((issue) => issue.type === "partial_check")?.message ??
  genericMessage;

/** Anonymize each paragraph's text and inline-run text in a clause body. */
const pushClauseBodyTexts = ({
  body,
  fields: sink,
  workspaceId,
}: {
  body: ClauseBody;
  fields: McpStructuredTextField[];
  workspaceId: string;
}): void => {
  for (const paragraph of body) {
    pushTextField({
      apply: (value) => {
        paragraph.text = value;
      },
      fields: sink,
      value: paragraph.text,
      workspaceId,
    });
    if (paragraph.runs) {
      for (const run of paragraph.runs) {
        pushTextField({
          apply: (value) => {
            run.text = value;
          },
          fields: sink,
          value: run.text,
          workspaceId,
        });
      }
    }
  }
};

// --- list_clauses -------------------------------------------------------

const listClausesArgsSchema = v.pipe(
  v.strictObject({
    clause_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    version_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    category_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    query: v.optional(v.pipe(v.string(), v.minLength(1))),
    include_categories: v.optional(v.boolean()),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.clausesPageSizeMax),
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
  // version_id selects one version of a specific clause, so it needs clause_id.
  v.forward(
    v.partialCheck(
      [["clause_id"], ["version_id"]],
      ({ clause_id, version_id }) =>
        version_id === undefined || clause_id !== undefined,
      "version_id requires clause_id",
    ),
    ["version_id"],
  ),
  // The list-only filters have no meaning in detail mode (a single clause_id).
  v.partialCheck(
    [
      ["clause_id"],
      ["category_id"],
      ["query"],
      ["include_categories"],
      ["limit"],
      ["cursor"],
    ],
    (i) =>
      i.clause_id === undefined ||
      (i.category_id === undefined &&
        i.query === undefined &&
        i.include_categories === undefined &&
        i.limit === undefined &&
        i.cursor === undefined),
    "category_id, query, include_categories, limit, and cursor apply to list mode; drop clause_id to list",
  ),
);

const readClauseDetail = async ({
  clauseId,
  context,
  versionId,
}: {
  clauseId: SafeId<"clause">;
  context: McpRequestContext;
  versionId: string | undefined;
}) => {
  const organizationId = context.organizationId;

  if (versionId !== undefined) {
    const result = await Result.gen(() =>
      getClauseVersionHandler({
        safeDb: context.safeDb,
        organizationId,
        clauseId,
        versionId: brandPersistedClauseVersionId(versionId),
      }),
    );
    if (Result.isError(result)) {
      return errorResult(result.error.message);
    }
    const version = result.value;
    const textFields: McpStructuredTextField[] = [];
    if (isClauseBody(version.body)) {
      pushClauseBodyTexts({
        body: version.body,
        fields: textFields,
        workspaceId: organizationId,
      });
    }
    return { egress: "structured", payload: { version }, textFields } as const;
  }

  const result = await Result.gen(() =>
    getClauseHandler({ safeDb: context.safeDb, organizationId, clauseId }),
  );
  if (Result.isError(result)) {
    return errorResult(result.error.message);
  }
  const clause = result.value;
  const textFields: McpStructuredTextField[] = [];
  pushTextField({
    apply: (value) => {
      clause.title = value;
    },
    fields: textFields,
    value: clause.title,
    workspaceId: organizationId,
  });
  pushTextField({
    apply: (value) => {
      clause.description = value;
    },
    fields: textFields,
    value: clause.description,
    workspaceId: organizationId,
  });
  pushTextField({
    apply: (value) => {
      clause.usageNotes = value;
    },
    fields: textFields,
    value: clause.usageNotes,
    workspaceId: organizationId,
  });
  if (isClauseBody(clause.body)) {
    pushClauseBodyTexts({
      body: clause.body,
      fields: textFields,
      workspaceId: organizationId,
    });
  }
  for (const variant of clause.variants) {
    pushTextField({
      apply: (value) => {
        variant.label = value;
      },
      fields: textFields,
      value: variant.label,
      workspaceId: organizationId,
    });
    if (isClauseBody(variant.body)) {
      pushClauseBodyTexts({
        body: variant.body,
        fields: textFields,
        workspaceId: organizationId,
      });
    }
  }
  return { egress: "structured", payload: { clause }, textFields } as const;
};

const handleListClausesTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listClausesArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { clause_id?: string, version_id?: string, category_id?: string, query?: string, include_categories?: boolean, limit?: integer, cursor?: string }",
      ),
    );
  }
  const input = parsed.output;

  // Detail mode.
  if (input.clause_id !== undefined) {
    return await readClauseDetail({
      clauseId: brandPersistedClauseId(input.clause_id),
      context,
      versionId: input.version_id,
    });
  }

  // List mode.
  const organizationId = context.organizationId;
  const listed = await Result.gen(() =>
    listClausesHandler({
      safeDb: context.safeDb,
      organizationId,
      query: {
        ...(input.category_id === undefined
          ? {}
          : { categoryId: brandPersistedClauseCategoryId(input.category_id) }),
        ...(input.query === undefined ? {} : { q: input.query }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
    }),
  );
  if (Result.isError(listed)) {
    return errorResult(listed.error.message);
  }
  const clauses = listed.value.items;

  // Sequential await, not Promise.all: a single safeDb client cannot multiplex
  // the clause and category queries concurrently.
  const categoriesResult =
    input.include_categories === true
      ? await Result.gen(() =>
          listCategoriesHandler({
            safeDb: context.safeDb,
            organizationId,
          }),
        )
      : undefined;
  if (categoriesResult !== undefined && Result.isError(categoriesResult)) {
    return errorResult(categoriesResult.error.message);
  }
  const categories =
    categoriesResult !== undefined && !Result.isError(categoriesResult)
      ? categoriesResult.value.categories
      : undefined;

  const textFields: McpStructuredTextField[] = [];
  for (const clause of clauses) {
    pushTextField({
      apply: (value) => {
        clause.title = value;
      },
      fields: textFields,
      value: clause.title,
      workspaceId: organizationId,
    });
    pushTextField({
      apply: (value) => {
        clause.description = value;
      },
      fields: textFields,
      value: clause.description,
      workspaceId: organizationId,
    });
  }
  if (categories) {
    for (const category of categories) {
      pushTextField({
        apply: (value) => {
          category.name = value;
        },
        fields: textFields,
        value: category.name,
        workspaceId: organizationId,
      });
      pushTextField({
        apply: (value) => {
          category.description = value;
        },
        fields: textFields,
        value: category.description,
        workspaceId: organizationId,
      });
    }
  }

  return {
    egress: "structured",
    payload: {
      clauses,
      ...(categories ? { categories } : {}),
      nextCursor: listed.value.nextCursor,
    },
    textFields,
  };
};

// --- save_clause --------------------------------------------------------

const clauseRunArgSchema = v.strictObject({
  text: v.string(),
  bold: v.optional(v.boolean()),
  italic: v.optional(v.boolean()),
});

const clauseParagraphArgSchema = v.strictObject({
  text: v.string(),
  style: v.optional(v.string()),
  level: v.optional(v.pipe(v.number(), v.integer())),
  runs: v.optional(v.array(clauseRunArgSchema)),
  listKind: v.optional(v.picklist(CLAUSE_LIST_KINDS)),
  listLevel: v.optional(v.pipe(v.number(), v.integer())),
  isDirective: v.optional(v.boolean()),
  directiveKind: v.optional(v.picklist(CLAUSE_DIRECTIVE_KINDS)),
  directiveExpression: v.optional(v.string()),
});

const clauseBodyArgSchema = v.pipe(
  v.array(clauseParagraphArgSchema),
  v.minLength(1),
);

const saveClauseArgsSchema = v.pipe(
  v.strictObject({
    clause_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
    body: v.optional(clauseBodyArgSchema),
    category_id: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
    language: v.optional(
      v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(10))),
    ),
    description: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
    usage_notes: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
    metadata: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
    snapshot_version: v.optional(v.boolean()),
  }),
  // Creating (no clause_id) requires a title.
  v.forward(
    v.partialCheck(
      [["clause_id"], ["title"]],
      ({ clause_id, title }) => clause_id !== undefined || title !== undefined,
      "title is required to create a clause",
    ),
    ["title"],
  ),
  // Creating (no clause_id) requires a body.
  v.forward(
    v.partialCheck(
      [["clause_id"], ["body"]],
      ({ clause_id, body }) => clause_id !== undefined || body !== undefined,
      "body is required to create a clause",
    ),
    ["body"],
  ),
  // A version snapshot only makes sense for an existing clause.
  v.forward(
    v.partialCheck(
      [["clause_id"], ["snapshot_version"]],
      ({ clause_id, snapshot_version }) =>
        clause_id !== undefined || snapshot_version === undefined,
      "snapshot_version only applies when updating a clause",
    ),
    ["snapshot_version"],
  ),
  // An update must request at least one change.
  v.partialCheck(
    [
      ["clause_id"],
      ["title"],
      ["body"],
      ["category_id"],
      ["language"],
      ["description"],
      ["usage_notes"],
      ["metadata"],
      ["snapshot_version"],
    ],
    (i) =>
      i.clause_id === undefined ||
      i.title !== undefined ||
      i.body !== undefined ||
      i.category_id !== undefined ||
      i.language !== undefined ||
      i.description !== undefined ||
      i.usage_notes !== undefined ||
      i.metadata !== undefined ||
      i.snapshot_version !== undefined,
    "Provide at least one field to change",
  ),
);

const handleSaveClauseTool: McpToolHandler = async ({ args, context }) => {
  const parsed = v.safeParse(saveClauseArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { clause_id?: string, title?: string, body?: array, category_id?: string|null, language?: string|null, description?: string|null, usage_notes?: string|null, metadata?: object|null, snapshot_version?: boolean }",
      ),
    );
  }
  const input = parsed.output;

  // The clause body is validated structurally with isClauseBody so it narrows
  // to the ClauseBody the backing handlers expect without an unchecked cast.
  let clauseBody: ClauseBody | undefined;
  if (input.body !== undefined) {
    if (!isClauseBody(input.body)) {
      return errorResult(
        "Invalid input: body must be a non-empty paragraph array",
      );
    }
    clauseBody = input.body;
  }

  const organizationId = context.organizationId;

  // Create branch.
  if (input.clause_id === undefined) {
    if (!roles[context.memberRole].authorize({ clause: ["create"] }).success) {
      return errorResult("Forbidden");
    }
    // The schema guarantees title and body are present on create.
    if (clauseBody === undefined) {
      return errorResult("body is required to create a clause");
    }
    const created = await Result.gen(() =>
      createClauseHandler({
        safeDb: context.safeDb,
        organizationId,
        userId: context.userId,
        recordAuditEvent: context.recordAuditEvent,
        body: {
          title: input.title ?? "",
          body: clauseBody,
          ...(input.category_id
            ? { categoryId: brandPersistedClauseCategoryId(input.category_id) }
            : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.usage_notes ? { usageNotes: input.usage_notes } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      }),
    );
    if (Result.isError(created)) {
      return errorResult(created.error.message);
    }
    return textResult({ clauseId: created.value.id });
  }

  // Update branch. Bind clauseId in the narrowed scope: inside the closure below
  // TypeScript would otherwise widen input.clause_id back to string | undefined.
  if (!roles[context.memberRole].authorize({ clause: ["update"] }).success) {
    return errorResult("Forbidden");
  }
  const clauseId = brandPersistedClauseId(input.clause_id);
  const updated = await Result.gen(() =>
    updateClauseHandler({
      safeDb: context.safeDb,
      organizationId,
      clauseId,
      recordAuditEvent: context.recordAuditEvent,
      body: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(clauseBody === undefined ? {} : { body: clauseBody }),
        ...(input.category_id === undefined
          ? {}
          : {
              categoryId:
                input.category_id === null
                  ? null
                  : brandPersistedClauseCategoryId(input.category_id),
            }),
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.usage_notes === undefined
          ? {}
          : { usageNotes: input.usage_notes }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.snapshot_version === undefined
          ? {}
          : { snapshotVersion: input.snapshot_version }),
      },
    }),
  );
  if (Result.isError(updated)) {
    return errorResult(updated.error.message);
  }
  return textResult({ clauseId: updated.value.id });
};

// --- delete_clause ------------------------------------------------------

const deleteClauseArgsSchema = v.strictObject({
  clause_id: v.pipe(v.string(), v.minLength(1)),
});

const handleDeleteClauseTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ clause: ["delete"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(deleteClauseArgsSchema, args);
  if (!parsed.success) {
    return errorResult("Invalid input: expected { clause_id: string }");
  }

  const deleted = await Result.gen(() =>
    deleteClauseHandler({
      safeDb: context.safeDb,
      organizationId: context.organizationId,
      clauseId: brandPersistedClauseId(parsed.output.clause_id),
      recordAuditEvent: context.recordAuditEvent,
    }),
  );
  if (Result.isError(deleted)) {
    return errorResult(deleted.error.message);
  }
  return textResult({ deleted: true });
};

// --- list_playbooks -----------------------------------------------------

const listPlaybooksArgsSchema = v.pipe(
  v.strictObject({
    playbook_id: v.optional(v.pipe(v.string(), v.minLength(1))),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(LIMITS.playbookDefinitionsPageSizeMax),
      ),
    ),
    cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
  }),
  // limit/cursor page the list; they have no meaning for a single playbook_id.
  v.partialCheck(
    [["playbook_id"], ["limit"], ["cursor"]],
    (i) =>
      i.playbook_id === undefined ||
      (i.limit === undefined && i.cursor === undefined),
    "limit and cursor apply to list mode; drop playbook_id to list",
  ),
);

const readPlaybookDetail = async ({
  context,
  playbookId,
}: {
  context: McpRequestContext;
  playbookId: SafeId<"playbookDefinition">;
}) => {
  const organizationId = context.organizationId;
  const result = await Result.gen(() =>
    getPlaybookDefinitionHandler({
      safeDb: context.safeDb,
      organizationId,
      playbookId,
    }),
  );
  if (Result.isError(result)) {
    return errorResult(result.error.message);
  }
  const playbook = result.value;

  const textFields: McpStructuredTextField[] = [];
  pushTextField({
    apply: (value) => {
      playbook.name = value;
    },
    fields: textFields,
    value: playbook.name,
    workspaceId: organizationId,
  });
  pushTextField({
    apply: (value) => {
      playbook.description = value;
    },
    fields: textFields,
    value: playbook.description,
    workspaceId: organizationId,
  });
  for (const position of playbook.positions.items) {
    pushTextField({
      apply: (value) => {
        position.issue = value;
      },
      fields: textFields,
      value: position.issue,
      workspaceId: organizationId,
    });
    pushTextField({
      apply: (value) => {
        position.ask.question = value;
      },
      fields: textFields,
      value: position.ask.question,
      workspaceId: organizationId,
    });
    pushTextField({
      apply: (value) => {
        position.guidance = value;
      },
      fields: textFields,
      value: position.guidance,
      workspaceId: organizationId,
    });
    if (position.standard.source === "inline") {
      const standard = position.standard;
      pushTextField({
        apply: (value) => {
          standard.preferred = value;
        },
        fields: textFields,
        value: standard.preferred,
        workspaceId: organizationId,
      });
      if (standard.fallbacks !== undefined) {
        for (const fallback of standard.fallbacks) {
          pushTextField({
            apply: (value) => {
              fallback.label = value;
            },
            fields: textFields,
            value: fallback.label,
            workspaceId: organizationId,
          });
          pushTextField({
            apply: (value) => {
              fallback.text = value;
            },
            fields: textFields,
            value: fallback.text,
            workspaceId: organizationId,
          });
        }
      }
    }
  }

  return { egress: "structured", payload: { playbook }, textFields } as const;
};

const handleListPlaybooksTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ workspace: ["read"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listPlaybooksArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      crossFieldOrGeneric(
        parsed.issues,
        "Invalid input: expected { playbook_id?: string, limit?: integer, cursor?: string }",
      ),
    );
  }
  const input = parsed.output;

  if (input.playbook_id !== undefined) {
    return await readPlaybookDetail({
      context,
      playbookId: brandPersistedPlaybookDefinitionId(input.playbook_id),
    });
  }

  const organizationId = context.organizationId;
  const listed = await Result.gen(() =>
    listPlaybookDefinitionsHandler({
      safeDb: context.safeDb,
      organizationId,
      query: {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
    }),
  );
  if (Result.isError(listed)) {
    return errorResult(listed.error.message);
  }
  const items = listed.value.items;

  const textFields: McpStructuredTextField[] = [];
  for (const item of items) {
    pushTextField({
      apply: (value) => {
        item.name = value;
      },
      fields: textFields,
      value: item.name,
      workspaceId: organizationId,
    });
    pushTextField({
      apply: (value) => {
        item.description = value;
      },
      fields: textFields,
      value: item.description,
      workspaceId: organizationId,
    });
  }

  return {
    egress: "structured",
    payload: { items, nextCursor: listed.value.nextCursor },
    textFields,
  };
};

// --- run_playbook -------------------------------------------------------

const runPlaybookArgsSchema = v.strictObject({
  matter_id: v.pipe(v.string(), v.minLength(1)),
  playbook_id: v.pipe(v.string(), v.minLength(1)),
});

const handleRunPlaybookTool: McpToolHandler = async ({ args, context }) => {
  if (!roles[context.memberRole].authorize({ playbook: ["apply"] }).success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(runPlaybookArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { matter_id: string, playbook_id: string }",
    );
  }

  // A playbook run materializes columns in the matter, so the matter must be
  // active, matching the HTTP run route behind the active-only workspace group.
  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: parsed.output.matter_id,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }
  const organizationId = context.organizationId;
  const playbookId = brandPersistedPlaybookDefinitionId(
    parsed.output.playbook_id,
  );
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);

  // Mirror the HTTP run handler: resolve the org-scoped definition and
  // materialize its columns in one transaction, then enqueue the workflow.
  // Usage is metered downstream per extracted property by the workflow, not
  // synchronously here (the HTTP route defers metering the same way).
  const txResult = await context.safeDb(async (tx) => {
    const playbook = await tx.query.playbookDefinitions.findFirst({
      where: {
        id: { eq: playbookId },
        organizationId: { eq: organizationId },
      },
      columns: { positions: true, scope: true },
    });
    if (!playbook) {
      return {
        ok: false as const,
        status: 404 as const,
        message: "Playbook not found",
      };
    }
    return await materializePlaybookRun({
      tx,
      workspaceId,
      organizationId,
      playbookId,
      positions: playbook.positions.items,
      scope: playbook.scope,
      recordAuditEvent,
    });
  });
  if (Result.isError(txResult)) {
    return errorResult(txResult.error.message);
  }
  const outcome = txResult.value;
  if (!outcome.ok) {
    return errorResult(outcome.message);
  }

  if (outcome.materializedPropertyIds.length === 0) {
    return textResult({ runPropertyCount: 0 });
  }

  const started = await Result.tryPromise({
    try: async () =>
      await startWorkflow({
        workspaceId,
        organizationId,
        userId: context.userId,
        scopedDb: context.scopedDb,
        propertyIds: outcome.materializedPropertyIds,
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(started)) {
    captureError(started.error, { workspaceId });
    return errorResult("Failed to start playbook review");
  }

  return textResult({
    runPropertyCount: outcome.materializedPropertyIds.length,
  });
};

export const KNOWLEDGE_TOOL_HANDLERS = {
  delete_clause: handleDeleteClauseTool,
  list_clauses: handleListClausesTool,
  list_playbooks: handleListPlaybooksTool,
  run_playbook: handleRunPlaybookTool,
  save_clause: handleSaveClauseTool,
} satisfies Record<KnowledgeToolName, McpToolHandler>;
