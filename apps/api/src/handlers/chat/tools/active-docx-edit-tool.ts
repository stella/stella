import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { toolDefinition } from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import {
  FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA,
  folioDocumentOperationBatchSchema,
} from "@stll/folio-agents";
import type {
  FolioAIEditOperation,
  FolioAIEditSeverity,
  FolioAIEditSkipReason,
} from "@stll/folio-core/ai-edits";
import { FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION } from "@stll/folio-core/server";

import { normalizeActiveDocxEditToolInput } from "@/api/handlers/chat/tools/active-docx-edit-tool-repair";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";

export const APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME = "apply-active-docx-edits";

/**
 * The tool's per-operation input shapes are DERIVED from folio's exported
 * contract schemas (`FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA` in
 * `@stll/folio-agents`), not hand-mirrored: the exported `oneOf` variants
 * are filtered to the operation types this surface accepts and stella's
 * narrowings are applied mechanically on top. Runtime validation delegates
 * per-operation shape checking to folio's own strict batch parser
 * (`folioDocumentOperationBatchSchema`), so folio owns contract conformance;
 * stella only validates its envelope and narrowings.
 *
 * Deliberate divergences from the folio batch contract, all narrowing:
 * - `severity` / `area` are REQUIRED (folio's `FolioAIEditReviewMeta` has
 *   them optional): the review panel sorts by severity and groups by area.
 * - `formatRange` is not accepted: it is a direct-only operation (see
 *   `FOLIO_DOCUMENT_OPERATION_MODES_BY_TYPE`) and this surface queues
 *   suggestions into a tracked-changes review flow whose prompt explicitly
 *   promises no run-formatting changes.
 * - `precondition` (blockTextHash) is not accepted: the model never sees
 *   block text hashes on this surface, so it could only fabricate them.
 * - the operation `id` is OPTIONAL (folio requires it): the executor
 *   generates ids for operations that omit one, same semantics as folio's
 *   `suggest_changes` tool.
 * - `mode` / `atomic` / `dryRun` are not accepted on the batch: operations
 *   are queued for per-suggestion human review, not applied, so none of the
 *   three can be honored. The strict envelope rejects them; the repair
 *   layer then strips the envelope down to `version`/`operations` and
 *   revalidates, so a stray option is dropped rather than honored.
 */

// ---------------------------------------------------------------------------
// Input types, derived from folio's operation union with the same narrowings
// the JSON-schema derivation below applies.
// ---------------------------------------------------------------------------

const REJECTED_OPERATION_TYPES = ["formatRange"] as const;
type RejectedOperationType = (typeof REJECTED_OPERATION_TYPES)[number];

type AcceptedFolioOperation = Exclude<
  FolioAIEditOperation,
  { type: RejectedOperationType }
>;

// Distributes over the union so the `type` discriminator survives: drop the
// rejected `precondition`, make the operation `id` optional, and require the
// review metadata (`severity` / `area`).
type NarrowToActiveDocxEditOperation<TOperation> = TOperation extends unknown
  ? Omit<TOperation, "id" | "precondition" | "severity" | "area"> & {
      id?: string;
      severity: FolioAIEditSeverity;
      area: string;
    }
  : never;

type ActiveDocxEditOperation =
  NarrowToActiveDocxEditOperation<AcceptedFolioOperation>;

type ActiveDocxEditToolInput = {
  version?: typeof FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION;
  operations: ActiveDocxEditOperation[];
};

type ValidatedActiveDocxEditToolInput = {
  version: typeof FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION;
  operations: ActiveDocxEditOperation[];
};

// ---------------------------------------------------------------------------
// JSON-schema derivation: filter folio's exported variants, narrow, and keep
// stella's surface-specific field descriptions where they carry guidance
// folio's generic contract descriptions lack.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Long contracts routinely produce 50+ legitimate ops in one redline pass
// (verified in trace: a 40-op cross-reference cleanup hit the old 20 cap and
// the tool returned error-text — the model then claimed "40 ready" because
// it didn't read the validation failure). The review panel sorts/groups
// large batches fine; the ceiling here is just a sanity guard, not a UX
// limit.
const MAX_OPERATIONS_PER_BATCH = 200;

const STYLE_ID_DESCRIPTION =
  "Optional Word paragraph style id to apply to the inserted or " +
  "replaced paragraph. Use canonical legal-source ids: " +
  '"ClauseHeading1", "ClauseHeading2", "ClauseHeading3" for ' +
  "numbered headings. Leave unset for plain body paragraphs.";

// Description overrides shared by every operation variant. `severity` and
// `area` double as folio's optional review metadata made required, so their
// texts explain the requirement; `id` explains the optional-id semantics of
// this surface (folio requires ids, the executor generates missing ones).
const SHARED_PROPERTY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  id:
    "Optional operation id, echoed back in `queued`/`skipped` so results " +
    "can be matched to operations. Auto-generated when omitted. This is " +
    "NOT the target block — that goes in `blockId`.",
  severity:
    'Required. "low" for typos, spelling, minor style; "medium" for ' +
    'wording or terminology fixes; "high" for substantive changes ' +
    "(numbers, dates, parties, legal effect). The review panel " +
    "sorts by this — pick one.",
  area:
    "Required. Short topic label that groups related operations: " +
    '"Spelling", "Names", "Penalty", "Arbitration", "Payment Terms", ' +
    '"Cross-references", "General". The review panel groups by this — ' +
    "use a consistent label across operations that belong together.",
  blockId:
    'Block id from the active DOCX editing snapshot, for example "b-0010".',
};

const INSERT_PROPERTY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  text:
    "Text for the inserted block. May be empty when `pageBreakBefore` is " +
    "true (the inserted paragraph exists only to force a page break).",
  pageBreakBefore:
    "When true, the inserted paragraph carries `pageBreakBefore` so the " +
    "layout starts it on a new page. Use this for explicit page breaks " +
    "instead of literal directive text.",
  styleId: STYLE_ID_DESCRIPTION,
};

const PROPERTY_DESCRIPTIONS_BY_OPERATION_TYPE: Readonly<
  Record<string, Readonly<Record<string, string>> | undefined>
> = {
  insertAfterBlock: INSERT_PROPERTY_DESCRIPTIONS,
  insertBeforeBlock: INSERT_PROPERTY_DESCRIPTIONS,
  replaceBlock: { styleId: STYLE_ID_DESCRIPTION },
  insertSignatureTable: {
    parties:
      "Parties to render side-by-side in the signature table, " +
      "one column per party. Each column has the party name " +
      "bold, two blank spacer lines, an underscore signature " +
      "rule, then optional signatory and italic title lines.",
  },
};

// Fallback review-meta property schemas, used only if a future folio version
// stops declaring `severity` / `area` on a variant (they are part of
// `FolioAIEditReviewMeta` today).
const FALLBACK_REVIEW_META_PROPERTIES: Readonly<Record<string, JsonObject>> = {
  severity: { type: "string", enum: ["low", "medium", "high"] },
  area: { type: "string" },
};

type DerivedOperationVariant = {
  operationType: string;
  schema: JsonObject;
  /**
   * Advertised property keys. Unknown keys are stripped before validation
   * instead of rejected: the model occasionally tacks on fields valid on
   * one variant but not another (e.g. `position` on `insertAfterBlock`),
   * and folio's strict parser would bounce the whole batch over a single
   * stray key — the user's approved edit would silently vanish.
   */
  propertyKeys: ReadonlySet<string>;
};

const deriveOperationVariant = (
  variant: JsonObject,
): DerivedOperationVariant => {
  const sourceProperties = variant["properties"];
  const sourceRequired = variant["required"];
  if (!isJsonObject(sourceProperties) || !Array.isArray(sourceRequired)) {
    panic("Malformed folio operation variant schema");
  }
  const typeProperty = sourceProperties["type"];
  // Typed as unknown[]: Array.isArray alone narrows to any[], which the
  // unsafe-any lint rules reject.
  const typeEnum: unknown[] | undefined =
    isJsonObject(typeProperty) && Array.isArray(typeProperty["enum"])
      ? typeProperty["enum"]
      : undefined;
  const operationType = typeEnum?.at(0);
  if (typeof operationType !== "string") {
    panic("Missing `type` discriminator in folio operation variant schema");
  }

  const properties: JsonObject = { ...sourceProperties };

  // Narrowing: `precondition` is not accepted on this surface.
  delete properties["precondition"];

  // Narrowing: review metadata is required (with a non-empty `area`).
  for (const [key, fallback] of Object.entries(
    FALLBACK_REVIEW_META_PROPERTIES,
  )) {
    const existing = properties[key];
    properties[key] = isJsonObject(existing) ? existing : fallback;
  }
  const areaProperty = properties["area"];
  if (isJsonObject(areaProperty)) {
    properties["area"] = { ...areaProperty, minLength: 1 };
  }

  const descriptionOverrides = {
    ...SHARED_PROPERTY_DESCRIPTIONS,
    ...PROPERTY_DESCRIPTIONS_BY_OPERATION_TYPE[operationType],
  };
  for (const [key, description] of Object.entries(descriptionOverrides)) {
    const property = properties[key];
    if (isJsonObject(property)) {
      properties[key] = { ...property, description };
    }
  }

  // Typed as unknown[]: Array.isArray alone narrows to any[], which the
  // unsafe-any lint rules reject.
  const requiredKeys: unknown[] = sourceRequired;
  const required = [
    // Narrowing: the operation id is optional on this surface.
    ...requiredKeys.filter((key) => key !== "id"),
    "severity",
    "area",
  ];

  return {
    operationType,
    schema: { ...variant, properties, required },
    propertyKeys: new Set(Object.keys(properties)),
  };
};

const REJECTED_OPERATION_TYPE_SET: ReadonlySet<string> = new Set(
  REJECTED_OPERATION_TYPES,
);

const ACCEPTED_OPERATION_VARIANTS = FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA.oneOf
  .map((variant) => deriveOperationVariant(variant))
  .filter((variant) => !REJECTED_OPERATION_TYPE_SET.has(variant.operationType));

const OPERATION_VARIANTS_BY_TYPE = new Map(
  ACCEPTED_OPERATION_VARIANTS.map((variant) => [
    variant.operationType,
    variant,
  ]),
);

const inputJsonSchema: JsonObject = {
  type: "object",
  properties: {
    version: {
      type: "integer",
      // Do not express the pinned numeric value as `enum: [1]` here.
      // OpenRouter's Gemini translation drops numeric-enum properties but
      // leaves them in the strict-mode `required` array, invalidating the
      // entire tool catalog. The runtime validator below still pins version 1.
      description: "Document-operation contract version. Always 1.",
    },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OPERATIONS_PER_BATCH,
      items: {
        description: FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA.description,
        oneOf: ACCEPTED_OPERATION_VARIANTS.map((variant) => variant.schema),
      },
      description: "Operations to apply to the active DOCX.",
    },
  },
  // `version` is optional with a pinned default rather than required:
  // pending approvals created before the versioned contract round-trip
  // through input validation when the user approves them, and they carry no
  // version.
  required: ["operations"],
  additionalProperties: false,
};

const providerSafeInputJsonSchema = projectToProviderSafeJsonSchema(
  inputJsonSchema,
  { nullUnionStrategy: "json-schema" },
).schema;

// ---------------------------------------------------------------------------
// Runtime validation: stella's envelope + narrowing checks, then folio's own
// strict batch parser for per-operation shape conformance.
// ---------------------------------------------------------------------------

const ENVELOPE_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  "version",
  "operations",
]);

type ValidationIssue = StandardSchemaV1.Issue;

const validationIssue = (
  message: string,
  path?: readonly PropertyKey[],
): ValidationIssue => ({ message, path });

const collectEnvelopeIssues = (input: JsonObject): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(input)) {
    if (!ENVELOPE_PROPERTY_KEYS.has(key)) {
      issues.push(
        validationIssue(
          `Unexpected property \`${key}\`: only \`version\` and ` +
            "`operations` are accepted. Operations are queued for human " +
            "review, so batch options like `mode`, `atomic`, and `dryRun` " +
            "cannot be honored here.",
          [key],
        ),
      );
    }
  }

  const version = input["version"];
  if (
    version !== undefined &&
    version !== FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION
  ) {
    issues.push(
      validationIssue(
        "Unsupported document-operation contract version: expected " +
          `${String(FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION)} (or omit it).`,
        ["version"],
      ),
    );
  }

  return issues;
};

type NarrowOperationArgs = {
  operation: unknown;
  index: number;
  issues: ValidationIssue[];
};

/**
 * Applies stella's narrowings to one operation: accepted `type` only,
 * `severity`/`area` required, unknown keys stripped (liberal mode, see
 * {@link DerivedOperationVariant.propertyKeys}). Returns the stripped
 * operation, or null after pushing issues.
 */
const narrowOperation = ({
  operation,
  index,
  issues,
}: NarrowOperationArgs): JsonObject | null => {
  if (!isJsonObject(operation)) {
    issues.push(
      validationIssue("Expected the operation to be an object.", [
        "operations",
        index,
      ]),
    );
    return null;
  }

  const operationType = operation["type"];
  const variant =
    typeof operationType === "string"
      ? OPERATION_VARIANTS_BY_TYPE.get(operationType)
      : undefined;
  if (variant === undefined) {
    const message =
      typeof operationType === "string" &&
      REJECTED_OPERATION_TYPE_SET.has(operationType)
        ? `Operation type "${operationType}" is not available on this surface.`
        : "Unknown operation `type`: expected one of " +
          `${[...OPERATION_VARIANTS_BY_TYPE.keys()].join(", ")}.`;
    issues.push(validationIssue(message, ["operations", index, "type"]));
    return null;
  }

  if (operation["severity"] === undefined) {
    issues.push(
      validationIssue('`severity` is required: "low", "medium", or "high".', [
        "operations",
        index,
        "severity",
      ]),
    );
  }
  const area = operation["area"];
  if (typeof area !== "string" || area.length === 0) {
    issues.push(
      validationIssue(
        '`area` is required: a short non-empty topic label (e.g. "Names").',
        ["operations", index, "area"],
      ),
    );
  }

  const stripped: JsonObject = {};
  for (const key of Object.keys(operation)) {
    if (variant.propertyKeys.has(key)) {
      stripped[key] = operation[key];
    }
  }
  return stripped;
};

const validateActiveDocxEditToolInput = (
  input: unknown,
): StandardSchemaV1.Result<ValidatedActiveDocxEditToolInput> => {
  if (!isJsonObject(input)) {
    return {
      issues: [
        validationIssue("Expected an object with an `operations` array."),
      ],
    };
  }

  const issues = collectEnvelopeIssues(input);

  const operations = input["operations"];
  if (!Array.isArray(operations)) {
    issues.push(
      validationIssue("Expected `operations` to be an array.", ["operations"]),
    );
    return { issues };
  }
  if (operations.length === 0) {
    issues.push(
      validationIssue("Expected at least one operation.", ["operations"]),
    );
  }
  if (operations.length > MAX_OPERATIONS_PER_BATCH) {
    issues.push(
      validationIssue(
        `Expected at most ${String(MAX_OPERATIONS_PER_BATCH)} operations ` +
          "per batch.",
        ["operations"],
      ),
    );
  }

  // `stripped` is returned to the caller (unknown keys removed, model ids
  // preserved); `parseable` is the folio-shaped copy with generated ids
  // filled in where the model omitted them, used only as a validation gate.
  const stripped: JsonObject[] = [];
  const parseable: JsonObject[] = [];
  for (const [index, operation] of operations.entries()) {
    const strippedOperation = narrowOperation({ operation, index, issues });
    if (strippedOperation === null) {
      continue;
    }
    stripped.push(strippedOperation);
    parseable.push(
      strippedOperation["id"] === undefined
        ? { ...strippedOperation, id: `auto-${Bun.randomUUIDv7()}` }
        : strippedOperation,
    );
  }

  if (issues.length > 0) {
    return { issues };
  }

  // No await: folio's batch schema is a synchronous valibot schema, so
  // `~standard.validate` types (and resolves) synchronously; if folio ever
  // turns it async the types change and this line fails typecheck.
  const folioResult = folioDocumentOperationBatchSchema["~standard"].validate({
    version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
    operations: parseable,
  });
  if (folioResult.issues !== undefined) {
    return { issues: folioResult.issues };
  }

  return {
    value: {
      version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
      // SAFETY: folio's strict batch parser just validated every
      // operation's shape against the same contract the derived JSON
      // schema advertises, and the loop above enforced stella's
      // narrowings (accepted type, required severity/area). The stripped
      // copies differ from the parsed batch only by the generated
      // placeholder ids, which are validation-only.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see the SAFETY note above; the parser validated the exact shape
      operations: stripped as ActiveDocxEditOperation[],
    },
  };
};

type ActiveDocxEditInputToolSchema = StandardJSONSchemaV1<
  ActiveDocxEditToolInput,
  ValidatedActiveDocxEditToolInput
> &
  StandardSchemaV1<ActiveDocxEditToolInput, ValidatedActiveDocxEditToolInput>;

const inputToolSchema: ActiveDocxEditInputToolSchema = {
  "~standard": {
    version: 1,
    vendor: "stella",
    validate: validateActiveDocxEditToolInput,
    jsonSchema: {
      input: () => providerSafeInputJsonSchema,
      output: () => providerSafeInputJsonSchema,
    },
  },
};

// ---------------------------------------------------------------------------
// Output schema: stella's queued-review result surface. `applied` receipts
// and skip reasons stay typed against folio's ai-edits types so a folio
// rename/removal fails typecheck here instead of silently drifting.
// ---------------------------------------------------------------------------

// Every skip reason folio's ai-edits engine can produce
// (`FolioAIEditSkipReason` in `@stll/folio-core`). `satisfies` keeps each
// entry checked against the folio union.
const FOLIO_AI_EDIT_SKIP_REASONS = [
  "missingBlock",
  "changedBlock",
  "ambiguousFind",
  "missingFind",
  "unsupportedBlock",
  "unsupportedMode",
  "atomicBatchRejected",
  "preconditionFailed",
  "staleRange",
  "emptyOperation",
  "noopOperation",
] as const satisfies readonly FolioAIEditSkipReason[];

const skippedOperationSchema = v.strictObject({
  id: v.string(),
  reason: v.picklist([
    ...FOLIO_AI_EDIT_SKIP_REASONS,
    // Stella-surface extension: the call arrived with no editable DOCX
    // open, so nothing could even be queued. Not a folio skip reason —
    // folio's executor is never invoked in that state.
    "documentNotEditable",
  ]),
});

// Mirrors folio's `FolioAIEditAppliedOperation` receipt (kept honest by the
// typed fixture in `active-docx-edit-tool.test.ts`): `commentId` for a
// created Word comment, `revisionId` / `revisionIds` for the tracked-change
// marks the operation produced (a replace carries separate deletion- and
// insertion-side ids).
const appliedOperationSchema = v.strictObject({
  id: v.string(),
  commentId: v.optional(v.number()),
  revisionId: v.optional(v.number()),
  revisionIds: v.optional(v.array(v.number())),
});

const outputSchema = v.strictObject({
  version: v.pipe(
    v.literal(FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION),
    v.description(
      "Document-operation contract version the executor speaks " +
        "(mirrors folio's `FolioDocumentOperationResult.version`).",
    ),
  ),
  applied: v.pipe(
    v.array(appliedOperationSchema),
    v.description(
      "Operations already written to the document by this tool call. " +
        "With the queued flow this list is normally empty; only claim a " +
        "change was made for ids that appear here.",
    ),
  ),
  queued: v.pipe(
    v.optional(
      v.array(
        v.strictObject({
          id: v.string(),
        }),
      ),
    ),
    v.description(
      "Operations now visible to the user as suggestions in the review " +
        "panel. NOT yet written to the document — the user reviews them " +
        "and applies each individually (or all at once). Tell the user " +
        "the suggestions are ready for review; do NOT claim the document " +
        "was changed. Do not retry these operations.",
    ),
  ),
  skipped: v.pipe(
    v.array(skippedOperationSchema),
    v.description(
      "Operations that could not be queued (e.g. no active file, " +
        "missing block). Tell the user plainly what is missing.",
    ),
  ),
});

const repairingInputToolSchema = {
  ...inputToolSchema,
  "~standard": {
    ...inputToolSchema["~standard"],
    validate: async (input: unknown) => {
      const initial = await inputToolSchema["~standard"].validate(input);
      if (initial.issues === undefined) {
        return initial;
      }

      const serialized = JSON.stringify(input);
      if (typeof serialized !== "string") {
        return initial;
      }

      const repaired = normalizeActiveDocxEditToolInput(serialized);
      if (repaired === null) {
        return initial;
      }

      return await inputToolSchema["~standard"].validate(JSON.parse(repaired));
    },
  },
} satisfies typeof inputToolSchema;

export const createActiveDocxEditTool = () =>
  toolDefinition({
    name: APPLY_ACTIVE_DOCX_EDITS_TOOL_NAME,
    description:
      "Propose edits for the DOCX currently open in the document " +
      "editor. Use this whenever the user asks to change, edit, " +
      "replace, rewrite, revise, or update text in the open DOCX, or asks " +
      "for a review/redline. Send a versioned operation batch: " +
      '`{"version": 1, "operations": [...]}`. ' +
      "Operations are queued for the user to review " +
      "and apply themselves; this tool does NOT write to the document. " +
      "Write document prose, not markdown: no `#` headings, list dashes, " +
      "or backticks. For a bold heading set `styleId` (e.g. ClauseHeading1). " +
      "Inserted block `text` may use `**bold**` / `***bold italic***` for " +
      "inline emphasis; in `replace` write plain text, since redlined " +
      "replacements are not re-formatted. See each schema field for its " +
      "semantics.",
    // No approval gate: this tool never writes to the document — it only
    // queues suggestions into the client review panel, where the user
    // reviews and applies each one (behind the editor's own unlock
    // prompt). The client auto-runs the queue-only executor on arrival,
    // the same way the folio-agents read tools auto-run. The meaningful
    // human gate is the per-suggestion Accept, not a chat approval click.
    needsApproval: false,
    inputSchema: repairingInputToolSchema,
    outputSchema: toTanStackToolSchema(outputSchema),
  });
