import { Result } from "better-result";
import * as v from "valibot";

import { BLOCK_DIRECTIVE_KINDS } from "@stll/template-conditions";

import { listCategoriesHandler } from "@/api/handlers/clauses/categories";
import { createClauseHandler } from "@/api/handlers/clauses/create";
import { deleteClauseHandler } from "@/api/handlers/clauses/delete";
import {
  getClauseHandler,
  getClauseVersionHandler,
  listClausesHandler,
} from "@/api/handlers/clauses/read";
import { updateClauseHandler } from "@/api/handlers/clauses/update";
import {
  getPlaybookDefinitionHandler,
  listPlaybookDefinitionsHandler,
} from "@/api/handlers/playbooks/read";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  DELETED_TRUE_PROJECTION,
  LIST_CLAUSES_DETAIL_PROJECTION,
  LIST_CLAUSES_LIST_PROJECTION,
  LIST_CLAUSES_PROJECTION,
  LIST_CLAUSES_VERSION_PROJECTION,
  LIST_PLAYBOOKS_DETAIL_PROJECTION,
  LIST_PLAYBOOKS_LIST_PROJECTION,
  LIST_PLAYBOOKS_PROJECTION,
  RUN_PLAYBOOK_PROJECTION,
  SAVE_CLAUSE_PROJECTION,
} from "@/api/lib/chat/projections";
import {
  CLAUSE_LIST_KINDS,
  type ClauseBody,
  type ClauseParagraph,
  type ClauseRun,
  isClauseBody,
} from "@/api/lib/clauses/types";
import { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import { openPlaybookRun } from "@/api/lib/document-review/open-playbook-run";
import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedClauseCategoryId,
  brandPersistedClauseId,
  brandPersistedClauseVersionId,
  brandPersistedPlaybookDefinitionId,
} from "@/api/lib/safe-id-boundaries";
import { startWorkflow } from "@/api/lib/workflow-queue";
import type {
  Position,
  PositionStandard,
  Tiers,
} from "@/api/lib/workflow/playbook-positions";
import { PLAYBOOK_RUN_PROJECTION } from "@/api/lib/workflow/playbook-run-projection";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
  runTextFieldSpecs,
} from "@/api/mcp/text-field-spec";
import type {
  McpTextFieldSpec,
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  ensureActiveWorkspace,
  errorResult,
  internalFailureResult,
  MCP_INTERNAL_ERROR_HINT,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  uuidInputSchema,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";

type KnowledgeToolName =
  | "list_clauses"
  | "save_clause"
  | "delete_clause"
  | "list_playbooks"
  | "run_playbook";

// --- Text-field specs (plan 049, Option B) --------------------------------
//
// Every anonymize-mode field below is organization-scoped: clauses and
// playbooks have no owning workspace, so `organizationId` is the
// anonymization scope everywhere. `organizationId` is not part of either
// served payload, so it is threaded in as a builder argument; the
// definitions below call these same builders with a placeholder id purely to
// derive the documented `textFields` path list — `deriveTextFieldPaths` only
// reads each spec's static `path`, never `scope`, so the placeholder never
// affects the declaration.

/**
 * Normalized read/write pair over one tenant-authored text unit. A clause
 * body paragraph's text and its optional inline runs' text both become one
 * unit apiece, so `clauseBodyTextFieldSpec` below can redact a whole body
 * (paragraphs + runs) as a single spec instead of re-deriving that shape at
 * every call site (clause body, clause variant bodies, standalone version
 * body).
 */
type TextUnit = {
  read: () => string | null | undefined;
  write: (value: string) => void;
};

/** A paragraph's inline runs, or an empty list when it has none. */
const clauseParagraphRuns = (
  paragraph: ClauseBody[number],
): readonly ClauseRun[] => {
  if (paragraph.runs === undefined) {
    return [];
  }
  return paragraph.runs;
};

const clauseBodyTextUnits = (body: ClauseBody): readonly TextUnit[] =>
  body.flatMap((paragraph): TextUnit[] => [
    {
      read: () => paragraph.text,
      write: (value) => {
        paragraph.text = value;
      },
    },
    ...clauseParagraphRuns(paragraph).map((run) => ({
      read: () => run.text,
      write: (value: string) => {
        run.text = value;
      },
    })),
  ]);

/**
 * One anonymize-mode spec over a whole `ClauseBody`, parameterized on the
 * `path` (`clause.body[].text` / `clause.variants[].body[].text` /
 * `version.body[].text`) and the `body` accessor for the branch's payload
 * shape. Every call site runs this only after its own `isClauseBody` guard
 * has passed (see the fail-closed control flow in `readClauseDetail`).
 */
const clauseBodyTextFieldSpec = <TPayload>({
  body,
  organizationId,
  path,
}: {
  body: (payload: TPayload) => ClauseBody;
  organizationId: string;
  path: string;
}): McpTextFieldSpec<TPayload> =>
  defineTextFieldSpec({
    path,
    items: (payload: TPayload) => clauseBodyTextUnits(body(payload)),
    scope: () => organizationId,
    read: (unit: TextUnit) => unit.read(),
    apply: (unit: TextUnit, value) => {
      unit.write(value);
    },
  });

const CLAUSE_BODY_TEXT_FIELD_PATH = "clause.body[].text";
const CLAUSE_VARIANT_BODY_TEXT_FIELD_PATH = "clause.variants[].body[].text";
const CLAUSE_VERSION_BODY_TEXT_FIELD_PATH = "version.body[].text";

// --- list_clauses ----------------------------------------------------------

type ClauseListItem = { title: string; description: string | null };
type ClauseCategoryItem = { name: string; description: string | null };

const clauseListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ clauses: readonly ClauseListItem[] }>[] => [
  defineTextFieldSpec({
    path: "clauses[].title",
    items: (payload) => payload.clauses,
    scope: () => organizationId,
    read: (item) => item.title,
    apply: (item, value) => {
      item.title = value;
    },
  }),
  defineTextFieldSpec({
    path: "clauses[].description",
    items: (payload) => payload.clauses,
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

const categoryListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{
  categories: readonly ClauseCategoryItem[];
}>[] => [
  defineTextFieldSpec({
    path: "categories[].name",
    items: (payload) => payload.categories,
    scope: () => organizationId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "categories[].description",
    items: (payload) => payload.categories,
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

type ClauseCoreItem = {
  title: string;
  description: string | null;
  usageNotes: string | null;
};

/** Clause detail: title/description/usageNotes. Pushed unconditionally
 * before either `isClauseBody` guard in `readClauseDetail` runs — matching
 * the original handler, where these are pushed first and only discarded (via
 * the guard's early error return) if the body turns out malformed. */
const clauseCoreTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ clause: ClauseCoreItem }>[] => [
  defineTextFieldSpec({
    path: "clause.title",
    items: (payload) => [payload.clause],
    scope: () => organizationId,
    read: (item) => item.title,
    apply: (item, value) => {
      item.title = value;
    },
  }),
  defineTextFieldSpec({
    path: "clause.description",
    items: (payload) => [payload.clause],
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  defineTextFieldSpec({
    path: "clause.usageNotes",
    items: (payload) => [payload.clause],
    scope: () => organizationId,
    read: (item) => item.usageNotes,
    apply: (item, value) => {
      item.usageNotes = value;
    },
  }),
];

type ClauseVariantLabelItem = { label: string };

const variantLabelTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ variant: ClauseVariantLabelItem }>[] => [
  defineTextFieldSpec({
    path: "clause.variants[].label",
    items: (payload) => [payload.variant],
    scope: () => organizationId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
];

const LIST_CLAUSES_TEXT_FIELD_PATHS = [
  ...deriveTextFieldPaths(clauseListTextFieldSpecs("")),
  ...deriveTextFieldPaths(categoryListTextFieldSpecs("")),
  ...deriveTextFieldPaths(clauseCoreTextFieldSpecs("")),
  CLAUSE_BODY_TEXT_FIELD_PATH,
  ...deriveTextFieldPaths(variantLabelTextFieldSpecs("")),
  CLAUSE_VARIANT_BODY_TEXT_FIELD_PATH,
  CLAUSE_VERSION_BODY_TEXT_FIELD_PATH,
];

// --- list_playbooks ---------------------------------------------------------

type PlaybookListItem = { name: string; description: string | null };

const playbookListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ items: readonly PlaybookListItem[] }>[] => [
  defineTextFieldSpec({
    path: "items[].name",
    items: (payload) => payload.items,
    scope: () => organizationId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "items[].description",
    items: (payload) => payload.items,
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

type GradedPosition = Extract<Position, { mode: "graded" }>;
type TierStandard = Extract<PositionStandard, { source: "tiers" }>;
type InlineIdeal = Extract<
  NonNullable<TierStandard["tiers"]["acceptable"]["ideal"]>,
  { source: "inline" }
>;

const gradedPositions = (
  positions: readonly Position[],
): readonly GradedPosition[] =>
  positions.flatMap((position) =>
    position.mode === "graded" ? [position] : [],
  );

// Only a tier standard carries authored prose. A reference standard's passages
// are quoted from a document the reader already has access to, and are
// redacted through the document's own path rather than the playbook's.
const tierLadders = (positions: readonly Position[]): readonly Tiers[] =>
  gradedPositions(positions).flatMap((position) =>
    position.standard.source === "tiers" ? [position.standard.tiers] : [],
  );

// Ask objects that carry a directly-authored question: every extract position
// and every graded position on the manual ask variant. The auto variant's
// derived question is redacted separately (`ask.derived.question`).
const manualAskItems = (
  positions: readonly Position[],
): readonly { question: string }[] =>
  positions.flatMap((position) => {
    if (position.mode === "extract") {
      return [position.ask];
    }
    return position.ask.mode === "manual" ? [position.ask] : [];
  });

const derivedAskItems = (
  positions: readonly Position[],
): readonly { question: string }[] =>
  gradedPositions(positions).flatMap((position) =>
    position.ask.mode === "auto" && position.ask.derived !== undefined
      ? [position.ask.derived]
      : [],
  );

const inlineIdealItems = (
  positions: readonly Position[],
): readonly InlineIdeal[] =>
  gradedPositions(positions).flatMap((position) => {
    if (position.standard.source !== "tiers") {
      return [];
    }
    const { ideal } = position.standard.tiers.acceptable;
    return ideal?.source === "inline" ? [ideal] : [];
  });

type NegotiationTextItem = {
  value: string | undefined;
  apply: (value: string) => void;
};

const negotiationScalarItems = (
  positions: readonly Position[],
  key: "escalation" | "rationale",
): readonly NegotiationTextItem[] =>
  gradedPositions(positions).flatMap((position) => {
    const negotiation = position.negotiation;
    if (negotiation === undefined) {
      return [];
    }

    return [
      {
        value: negotiation[key],
        apply: (value: string) => {
          negotiation[key] = value;
        },
      },
    ];
  });

const negotiationTalkingPointItems = (
  positions: readonly Position[],
): readonly NegotiationTextItem[] =>
  gradedPositions(positions).flatMap((position) => {
    const talkingPoints = position.negotiation?.talkingPoints;
    if (talkingPoints === undefined) {
      return [];
    }

    return talkingPoints.map((value, index) => ({
      value,
      apply: (next: string) => {
        talkingPoints[index] = next;
      },
    }));
  });

type PlaybookDetailPayload = {
  playbook: {
    name: string;
    description: string | null;
    positions: { items: readonly Position[] };
  };
};

/**
 * Every redactable field on one playbook detail response: the playbook's own
 * name/description, and per position its issue, purpose, guidance, and ask question
 * (the manual/extract question, or an auto position's derived question) —
 * plus, for a graded position, each tier rule (acceptable and not-acceptable
 * red lines), inline ideal language, and each fallback entry's text and label.
 * Deriving the declared `textFields` path list from these specs keeps the
 * documented paths and the runtime redaction in lockstep.
 */
const playbookDetailTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<PlaybookDetailPayload>[] => [
  defineTextFieldSpec({
    path: "playbook.name",
    items: (payload) => [payload.playbook],
    scope: () => organizationId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.description",
    items: (payload) => [payload.playbook],
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].issue",
    items: (payload) => payload.playbook.positions.items,
    scope: () => organizationId,
    read: (item) => item.issue,
    apply: (item, value) => {
      item.issue = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].ask.question",
    items: (payload) => manualAskItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.question,
    apply: (item, value) => {
      item.question = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].ask.derived.question",
    items: (payload) => derivedAskItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.question,
    apply: (item, value) => {
      item.question = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].purpose",
    items: (payload) => gradedPositions(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.purpose,
    apply: (item, value) => {
      item.purpose = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].guidance",
    items: (payload) => payload.playbook.positions.items,
    scope: () => organizationId,
    read: (item) => item.guidance,
    apply: (item, value) => {
      item.guidance = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].negotiation.rationale",
    items: (payload) =>
      negotiationScalarItems(payload.playbook.positions.items, "rationale"),
    scope: () => organizationId,
    read: (item) => item.value,
    apply: (item, value) => {
      item.apply(value);
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].negotiation.talkingPoints[]",
    items: (payload) =>
      negotiationTalkingPointItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.value,
    apply: (item, value) => {
      item.apply(value);
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].negotiation.escalation",
    items: (payload) =>
      negotiationScalarItems(payload.playbook.positions.items, "escalation"),
    scope: () => organizationId,
    read: (item) => item.value,
    apply: (item, value) => {
      item.apply(value);
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.acceptable.rules[].text",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.acceptable.rules,
      ),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.acceptable.ideal.text",
    items: (payload) => inlineIdealItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.fallback.entries[].text",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.fallback.entries,
      ),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.fallback.entries[].label",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.fallback.entries,
      ),
    scope: () => organizationId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.notAcceptable.rules[].text",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.notAcceptable.rules,
      ),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
];

// --- list_clauses -------------------------------------------------------

const listClausesArgsSchema = nullAsAbsent(
  v.pipe(
    v.strictObject({
      clause_id: v.optional(
        uuidInputSchema("Clause id to read in detail; omit to list"),
      ),
      version_id: v.optional(
        uuidInputSchema(
          "With clause_id, return this version's body instead of the current clause",
        ),
      ),
      category_id: v.optional(
        uuidInputSchema(
          "List only clauses filed under this category (list mode)",
        ),
      ),
      query: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.description(
            "Filter clauses by a text query over title and body (list mode)",
          ),
        ),
      ),
      include_categories: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            "Also return the organization's clause categories (list mode)",
          ),
        ),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.clausesPageSizeMax),
          v.description("Max clauses to return"),
        ),
      ),
      cursor: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(512),
          v.description(
            "Opaque cursor from a previous list_clauses call to fetch the next page",
          ),
        ),
      ),
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
      return internalFailureResult(result.error);
    }
    const rawVersion = result.value;
    // Fail-closed (P7): a malformed version body aborts before any push runs,
    // exactly the Wave 4 fix — kept as inline control flow, unchanged.
    if (!isClauseBody(rawVersion.body)) {
      return structuredErrorResult({
        code: "validation_error",
        message: "Clause body has an unrecognized format",
        issues: [
          { path: "body", message: "Clause body has an unrecognized format" },
        ],
      });
    }
    const version = {
      ...rawVersion,
      body: rawVersion.body,
      createdAt: rawVersion.createdAt.toISOString(),
    } satisfies v.InferInput<typeof LIST_CLAUSES_VERSION_PROJECTION>["version"];
    const textFields = runTextFieldSpecs(
      [
        clauseBodyTextFieldSpec({
          path: CLAUSE_VERSION_BODY_TEXT_FIELD_PATH,
          body: (payload: { version: { body: ClauseBody } }) =>
            payload.version.body,
          organizationId,
        }),
      ],
      { version },
    );
    return { egress: "structured", payload: { version }, textFields } as const;
  }

  const result = await Result.gen(() =>
    getClauseHandler({ safeDb: context.safeDb, organizationId, clauseId }),
  );
  if (Result.isError(result)) {
    return internalFailureResult(result.error);
  }
  const { metadata: _metadata, ...rawClause } = result.value;
  if (!isClauseBody(rawClause.body)) {
    return structuredErrorResult({
      code: "validation_error",
      message: "Clause body has an unrecognized format",
      issues: [
        { path: "body", message: "Clause body has an unrecognized format" },
      ],
    });
  }
  const variants = [];
  for (const rawVariant of rawClause.variants) {
    if (!isClauseBody(rawVariant.body)) {
      return structuredErrorResult({
        code: "validation_error",
        message: "Clause body has an unrecognized format",
        issues: [
          { path: "body", message: "Clause body has an unrecognized format" },
        ],
      });
    }
    variants.push({
      ...rawVariant,
      body: rawVariant.body,
      createdAt: rawVariant.createdAt.toISOString(),
    });
  }
  const clause = {
    ...rawClause,
    body: rawClause.body,
    createdAt: rawClause.createdAt.toISOString(),
    updatedAt: rawClause.updatedAt.toISOString(),
    variants,
    versions: rawClause.versions.map(({ createdAt, ...version }) =>
      Object.assign(version, { createdAt: createdAt.toISOString() }),
    ),
  } satisfies v.InferInput<typeof LIST_CLAUSES_DETAIL_PROJECTION>["clause"];
  const textFields = runTextFieldSpecs(
    clauseCoreTextFieldSpecs(organizationId),
    { clause },
  );
  textFields.push(
    ...runTextFieldSpecs(
      [
        clauseBodyTextFieldSpec({
          path: CLAUSE_BODY_TEXT_FIELD_PATH,
          body: (payload: { body: ClauseBody }) => payload.body,
          organizationId,
        }),
      ],
      { body: clause.body },
    ),
  );
  for (const variant of clause.variants) {
    textFields.push(
      ...runTextFieldSpecs(variantLabelTextFieldSpecs(organizationId), {
        variant,
      }),
    );
    textFields.push(
      ...runTextFieldSpecs(
        [
          clauseBodyTextFieldSpec({
            path: CLAUSE_VARIANT_BODY_TEXT_FIELD_PATH,
            body: (payload: { body: ClauseBody }) => payload.body,
            organizationId,
          }),
        ],
        { body: variant.body },
      ),
    );
  }
  return { egress: "structured", payload: { clause }, textFields } as const;
};

const handleListClausesTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_CLAUSES_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { workspace: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listClausesArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
    return internalFailureResult(listed.error);
  }
  const clauses = listed.value.items.map(
    ({ createdAt, updatedAt, ...clause }) =>
      Object.assign(clause, {
        createdAt: createdAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      }),
  );

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
    return internalFailureResult(categoriesResult.error);
  }
  const categories =
    categoriesResult !== undefined && !Result.isError(categoriesResult)
      ? categoriesResult.value.categories.map(
          ({ createdAt, updatedAt, ...category }) =>
            Object.assign(category, {
              createdAt: createdAt.toISOString(),
              updatedAt: updatedAt.toISOString(),
            }),
        )
      : undefined;

  const payload = {
    clauses,
    ...(categories ? { categories } : {}),
    nextCursor: listed.value.nextCursor,
  } satisfies v.InferInput<typeof LIST_CLAUSES_LIST_PROJECTION>;
  const textFields = [
    ...runTextFieldSpecs(clauseListTextFieldSpecs(organizationId), payload),
    ...(categories
      ? runTextFieldSpecs(categoryListTextFieldSpecs(organizationId), {
          categories,
        })
      : []),
  ];

  return { egress: "structured", payload, textFields };
};

// --- save_clause --------------------------------------------------------

const clauseRunArgSchema = v.strictObject({
  text: v.pipe(v.string(), v.description("Run text")),
  bold: v.optional(v.pipe(v.boolean(), v.description("Render the run bold"))),
  italic: v.optional(
    v.pipe(v.boolean(), v.description("Render the run italic")),
  ),
});

const clauseParagraphArgSchema = v.strictObject({
  text: v.pipe(v.string(), v.description("Paragraph plain text")),
  style: v.optional(
    v.pipe(v.string(), v.description("Optional paragraph style name")),
  ),
  level: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.description("Optional heading/outline level"),
    ),
  ),
  runs: v.optional(
    v.pipe(
      v.array(clauseRunArgSchema),
      v.description(
        "Optional inline formatting runs whose text concatenates to the paragraph",
      ),
    ),
  ),
  list_kind: v.optional(
    v.pipe(
      v.picklist(CLAUSE_LIST_KINDS),
      v.description("List item kind when the paragraph is a list item"),
    ),
  ),
  list_level: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.description("0-based list nesting depth for a list item"),
    ),
  ),
  is_directive: v.optional(
    v.pipe(
      v.boolean(),
      v.description("Whether the paragraph is a template directive marker"),
    ),
  ),
  directive_kind: v.optional(
    v.pipe(
      v.picklist(BLOCK_DIRECTIVE_KINDS),
      v.description("Directive kind when is_directive is set"),
    ),
  ),
  directive_expression: v.optional(
    v.pipe(
      v.string(),
      v.description("Directive expression for an if/each directive"),
    ),
  ),
});

const toClauseRun = (
  run: v.InferOutput<typeof clauseRunArgSchema>,
): ClauseRun => ({
  text: run.text,
  ...(run.bold === undefined ? {} : { bold: run.bold }),
  ...(run.italic === undefined ? {} : { italic: run.italic }),
});

/**
 * The MCP surface is snake_case; the persisted `ClauseParagraph` is camelCase.
 * Every target key is listed explicitly so a new schema key cannot reach the
 * persisted shape without a decision here.
 */
const toClauseParagraph = (
  paragraph: v.InferOutput<typeof clauseParagraphArgSchema>,
): ClauseParagraph => ({
  text: paragraph.text,
  ...(paragraph.style === undefined ? {} : { style: paragraph.style }),
  ...(paragraph.level === undefined ? {} : { level: paragraph.level }),
  ...(paragraph.runs === undefined
    ? {}
    : { runs: paragraph.runs.map(toClauseRun) }),
  ...(paragraph.list_kind === undefined
    ? {}
    : { listKind: paragraph.list_kind }),
  ...(paragraph.list_level === undefined
    ? {}
    : { listLevel: paragraph.list_level }),
  ...(paragraph.is_directive === undefined
    ? {}
    : { isDirective: paragraph.is_directive }),
  ...(paragraph.directive_kind === undefined
    ? {}
    : { directiveKind: paragraph.directive_kind }),
  ...(paragraph.directive_expression === undefined
    ? {}
    : { directiveExpression: paragraph.directive_expression }),
});

const clauseBodyArgSchema = v.pipe(
  v.array(clauseParagraphArgSchema),
  v.minLength(1),
  v.description(
    "Ordered clause body paragraphs; required when creating. Each paragraph " +
      "carries text and optional formatting.",
  ),
);

const saveClauseArgsSchema = nullAsAbsent(
  v.pipe(
    v.strictObject({
      clause_id: v.optional(
        uuidInputSchema("Clause id to update; omit to create"),
      ),
      title: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(256),
          v.description("Clause title; required when creating"),
        ),
      ),
      body: v.optional(clauseBodyArgSchema),
      category_id: v.optional(
        v.pipe(
          v.nullable(v.pipe(v.string(), v.uuid())),
          v.description(
            "Category id to file the clause under; pass null to clear",
          ),
        ),
      ),
      language: v.optional(
        v.pipe(
          v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(10))),
          v.description(
            "BCP-47 language tag for the clause; pass null to clear",
          ),
        ),
      ),
      description: v.optional(
        v.pipe(
          v.nullable(v.pipe(v.string(), v.maxLength(2000))),
          v.description("Short clause description; pass null to clear"),
        ),
      ),
      usage_notes: v.optional(
        v.pipe(
          v.nullable(v.pipe(v.string(), v.maxLength(2000))),
          v.description(
            "Guidance on when to use the clause; pass null to clear",
          ),
        ),
      ),
      metadata: v.optional(
        v.pipe(
          v.nullable(v.record(v.string(), v.unknown())),
          v.description("Free-form metadata object; pass null to clear"),
        ),
      ),
      snapshot_version: v.optional(
        v.pipe(
          v.boolean(),
          v.description(
            "When updating, also append a version snapshot of the body",
          ),
        ),
      ),
    }),
    // Creating (no clause_id) requires a title.
    v.forward(
      v.partialCheck(
        [["clause_id"], ["title"]],
        ({ clause_id, title }) =>
          clause_id !== undefined || title !== undefined,
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
  ),
);

const handleSaveClauseTool: TypedMcpToolHandler<
  v.InferInput<typeof SAVE_CLAUSE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(saveClauseArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  const clauseBody = input.body?.map(toClauseParagraph);

  const organizationId = context.organizationId;

  // Create branch.
  if (input.clause_id === undefined) {
    if (!hasEffectiveAuthority(context, { clause: ["create"] })) {
      return errorResult("Forbidden");
    }
    // The schema guarantees title and body are present on create. Bind title
    // in the narrowed scope: inside the closure below TypeScript would
    // otherwise widen input.title back to string | undefined.
    const { title } = input;
    if (title === undefined) {
      return structuredErrorResult({
        code: "validation_error",
        message: "title is required to create a clause",
        issues: [
          { path: "title", message: "title is required to create a clause" },
        ],
        hint: "Provide 'title' when clause_id is omitted (create mode).",
      });
    }
    if (clauseBody === undefined) {
      return structuredErrorResult({
        code: "validation_error",
        message: "body is required to create a clause",
        issues: [
          { path: "body", message: "body is required to create a clause" },
        ],
        hint: "Provide 'body' when clause_id is omitted (create mode).",
      });
    }
    const created = await Result.gen(() =>
      createClauseHandler({
        safeDb: context.safeDb,
        organizationId,
        userId: context.userId,
        recordAuditEvent: context.recordAuditEvent,
        body: {
          title,
          body: clauseBody,
          ...(input.category_id
            ? { categoryId: brandPersistedClauseCategoryId(input.category_id) }
            : {}),
          ...(input.language ? { language: input.language } : {}),
          ...(input.description !== undefined && input.description !== null
            ? { description: input.description }
            : {}),
          ...(input.usage_notes !== undefined && input.usage_notes !== null
            ? { usageNotes: input.usage_notes }
            : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      }),
    );
    if (Result.isError(created)) {
      return internalFailureResult(created.error);
    }
    return toolDataResult({
      clauseId: created.value.id,
    } satisfies v.InferInput<typeof SAVE_CLAUSE_PROJECTION>);
  }

  // Update branch. Bind clauseId in the narrowed scope: inside the closure below
  // TypeScript would otherwise widen input.clause_id back to string | undefined.
  if (!hasEffectiveAuthority(context, { clause: ["update"] })) {
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
    return internalFailureResult(updated.error);
  }
  return toolDataResult({
    clauseId: updated.value.id,
  } satisfies v.InferInput<typeof SAVE_CLAUSE_PROJECTION>);
};

// --- delete_clause ------------------------------------------------------

const deleteClauseArgsSchema = nullAsAbsent(
  v.strictObject({
    clause_id: uuidInputSchema("Clause id to delete"),
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

const handleDeleteClauseTool: TypedMcpToolHandler<
  v.InferInput<typeof DELETED_TRUE_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { clause: ["delete"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(deleteClauseArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
    return internalFailureResult(deleted.error);
  }
  return toolDataResult({
    deleted: true,
  } satisfies v.InferInput<typeof DELETED_TRUE_PROJECTION>);
};

// --- list_playbooks -----------------------------------------------------

const listPlaybooksArgsSchema = nullAsAbsent(
  v.pipe(
    v.strictObject({
      playbook_id: v.optional(
        uuidInputSchema(
          "Playbook id to read in detail; omit to list playbooks",
        ),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(LIMITS.playbookDefinitionsPageSizeMax),
          v.description("Max playbooks to return"),
        ),
      ),
      cursor: v.optional(
        v.pipe(
          v.string(),
          v.maxLength(512),
          v.description(
            "Opaque cursor from a previous list_playbooks call to fetch the next page",
          ),
        ),
      ),
    }),
    // limit/cursor page the list; they have no meaning for a single playbook_id.
    v.partialCheck(
      [["playbook_id"], ["limit"], ["cursor"]],
      (i) =>
        i.playbook_id === undefined ||
        (i.limit === undefined && i.cursor === undefined),
      "limit and cursor apply to list mode; drop playbook_id to list",
    ),
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
    return internalFailureResult(result.error);
  }
  const playbook = result.value;

  const textFields = runTextFieldSpecs(
    playbookDetailTextFieldSpecs(organizationId),
    { playbook },
  );

  return {
    egress: "structured",
    payload: { playbook } satisfies v.InferInput<
      typeof LIST_PLAYBOOKS_DETAIL_PROJECTION
    >,
    textFields,
  } as const;
};

const handleListPlaybooksTool: TypedMcpToolHandler<
  v.InferInput<typeof LIST_PLAYBOOKS_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { workspace: ["read"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(listPlaybooksArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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
    return internalFailureResult(listed.error);
  }
  const items = listed.value.items;

  const payload = {
    items,
    nextCursor: listed.value.nextCursor,
  } satisfies v.InferInput<typeof LIST_PLAYBOOKS_LIST_PROJECTION>;
  const textFields = runTextFieldSpecs(
    playbookListTextFieldSpecs(organizationId),
    payload,
  );

  return { egress: "structured", payload, textFields };
};

// --- run_playbook -------------------------------------------------------

const runPlaybookArgsSchema = nullAsAbsent(
  v.strictObject({
    matter_id: uuidInputSchema("Matter ID to run the playbook over."),
    playbook_id: uuidInputSchema("Playbook id to run"),
  }),
);

/**
 * A review whose workflow never started. Retryable by construction: the
 * materialized columns are upserted by playbook source id and left stale, so
 * calling the tool again maps back to the same columns and re-queues them
 * rather than materializing a second set.
 */
const workflowStartFailureResult = () =>
  structuredErrorResult({
    code: "internal_error",
    message: "Failed to start the review",
    hint: MCP_INTERNAL_ERROR_HINT,
    retryable: true,
  });

const handleRunPlaybookTool: TypedMcpToolHandler<
  v.InferInput<typeof RUN_PLAYBOOK_PROJECTION>
> = async ({ args, context }) => {
  if (!hasEffectiveAuthority(context, { playbook: ["apply"] })) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(runPlaybookArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
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

  // Mirror the HTTP run handler by calling exactly what it calls: pin the
  // playbook's approved snapshot, materialize its columns, and open one
  // durable review run per document, in one transaction. Usage is metered
  // downstream per extracted property by the workflow, not synchronously here
  // (the HTTP route defers metering the same way).
  const txResult = await context.safeDb(async (tx) => {
    const definition = await tx.query.playbookDefinitions.findFirst({
      where: {
        id: { eq: playbookId },
        organizationId: { eq: organizationId },
      },
      columns: { id: true, name: true, positions: true, scope: true },
    });
    if (!definition) {
      return {
        ok: false as const,
        status: 404 as const,
        message: "Playbook not found",
      };
    }
    return await openPlaybookRun({
      tx,
      workspaceId,
      organizationId,
      userId: context.userId,
      definition,
      latestApprovedVersion: await (
        context.testDependencies?.loadLatestApprovedVersion ??
        loadLatestApprovedVersion
      )({
        tx,
        organizationId,
        playbookDefinitionId: definition.id,
      }),
      projection: PLAYBOOK_RUN_PROJECTION.COLUMNS,
      recordAuditEvent,
      testDependencies: context.testDependencies,
    });
  });
  if (Result.isError(txResult)) {
    return internalFailureResult(txResult.error);
  }
  const outcome = txResult.value;
  if (!outcome.ok) {
    return errorResult(outcome.message);
  }

  if (outcome.materializedPropertyIds.length === 0) {
    return toolDataResult({ runPropertyCount: 0 } satisfies v.InferInput<
      typeof RUN_PLAYBOOK_PROJECTION
    >);
  }

  const started = await Result.tryPromise({
    try: async () =>
      await (context.testDependencies?.startWorkflow ?? startWorkflow)({
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
    return workflowStartFailureResult();
  }
  // The queue reports an enqueue failure in band (having already captured the
  // cause), so a success envelope here would promise an agent a review nothing
  // drives.
  if (
    playbookRunStartOutcome(started.value.status) ===
    PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED
  ) {
    return workflowStartFailureResult();
  }

  return toolDataResult({
    runPropertyCount: outcome.materializedPropertyIds.length,
  } satisfies v.InferInput<typeof RUN_PLAYBOOK_PROJECTION>);
};

export const KNOWLEDGE_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    annotations: {
      title: "List clauses",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List the clause library for this organization, or read one clause in " +
      "detail. Pass clause_id to get a clause's body, description, usage notes, " +
      "variants, and version history; add version_id to read one version's " +
      "body. Otherwise list clauses (newest first), optionally filtered by " +
      "category_id or a text query, and set include_categories to also return " +
      "the category tree. Returns each clause's id, title, category, language, " +
      "and current version.",
    inputSchema: listClausesArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The CLI trust boundary does not interpret the clause_id/version_id " +
        "dependency or the list-mode-only filters; both remain authoritative " +
        "in the runtime schema.",
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: LIST_CLAUSES_TEXT_FIELD_PATHS,
    },
    name: "list_clauses",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    description:
      "Create or update a clause in the organization's clause library. Omit " +
      "clause_id to create (title and body required); pass clause_id to update. " +
      "body is an ordered array of paragraphs, each with text and optional " +
      "style, level, runs, list_kind, list_level, is_directive, directive_kind, " +
      "and directive_expression. " +
      "category_id, language, description, usage_notes, and metadata " +
      "accept null to clear them on update. Set snapshot_version true on an " +
      "update to also append a version snapshot of the body. Returns the clause id.",
    inputSchema: saveClauseArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The CLI trust boundary does not interpret the create/update " +
        "cross-field dependencies; they remain authoritative in the runtime schema.",
    },
    annotations: {
      title: "Save clause",
      idempotentHint: false,
      openWorldHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "save_clause",
    scope: "stella:knowledge_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "Delete clause",
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Permanently delete a clause and all its variants and versions from the " +
      "organization's clause library. This is irreversible.",
    inputSchema: deleteClauseArgsSchema,
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "delete_clause",
    scope: "stella:knowledge_write",
  }),
  defineValibotMcpTool({
    annotations: {
      title: "List playbooks",
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List the review playbooks in this organization, or read one in detail. " +
      "Pass playbook_id to get a playbook's positions (the issues it reviews, " +
      "their questions, tiered rules, and ideal language), scope, and " +
      "description. " +
      "Otherwise list playbooks (newest first). Returns each playbook's id, " +
      "name, and description.",
    inputSchema: listPlaybooksArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["partial_check"],
      reason:
        "The CLI trust boundary does not interpret the list-mode-only " +
        "pagination dependency; it remains authoritative in the runtime schema.",
    },
    access: "read",
    anonymized: {
      exposure: "anonymize",
      textFields: [
        ...deriveTextFieldPaths(playbookListTextFieldSpecs("")),
        ...deriveTextFieldPaths(playbookDetailTextFieldSpecs("")),
      ],
    },
    name: "list_playbooks",
    scope: "stella:read",
  }),
  defineValibotMcpTool({
    description:
      "Run a review playbook over a matter's documents. Materializes the " +
      "playbook's extraction and verdict columns onto the matter's table " +
      "and starts the AI review; findings populate asynchronously. Pass " +
      "matter_id and playbook_id. Returns the number of columns queued for review.",
    inputSchema: runPlaybookArgsSchema,
    annotations: {
      title: "Run playbook",
      idempotentHint: false,
      openWorldHint: false,
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: "run_playbook",
    scope: "stella:knowledge_write",
  }),
] as const satisfies readonly McpToolDefinition[];

export const KNOWLEDGE_TOOL_HANDLERS = {
  delete_clause: handleDeleteClauseTool,
  list_clauses: handleListClausesTool,
  list_playbooks: handleListPlaybooksTool,
  run_playbook: handleRunPlaybookTool,
  save_clause: handleSaveClauseTool,
} satisfies Record<KnowledgeToolName, McpToolHandler>;

export const KNOWLEDGE_TOOL_SET = defineMcpToolSet(
  KNOWLEDGE_TOOL_DEFINITIONS,
  KNOWLEDGE_TOOL_HANDLERS,
);
