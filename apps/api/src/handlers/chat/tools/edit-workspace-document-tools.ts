import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { toolDefinition } from "@tanstack/ai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA,
  folioDocumentOperationBatchSchema,
} from "@stll/folio-agents";
import type {
  FolioAIEditOperation,
  FolioAIEditSkipReason,
} from "@stll/folio-core/ai-edits";
import {
  applyFolioAIEditsToBuffer,
  FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
} from "@stll/folio-core/server";

import type { SafeDb } from "@/api/db/safe-db";
import {
  DOCX_EDIT_REPRESENTATION,
  type DocxEditRepresentation,
} from "@/api/handlers/chat/chat-schema";
import { resolveDocxEditAuthorName } from "@/api/handlers/chat/tools/resolve-docx-edit-author-name";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-docx-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { projectToProviderSafeJsonSchema } from "@/api/lib/provider-safe-json-schema";

export const EDIT_WORKSPACE_DOCUMENT_TOOL_NAME = "edit_workspace_document";

/**
 * Server-executed, headless counterpart to `apply-active-docx-edits`: this
 * tool applies a versioned document-operation batch straight to the active
 * DOCX and writes a new entity version, with no browser review panel in the
 * loop. `chat-tools.ts` registers exactly one of the two tools per turn
 * (`editApplyMode`), never both.
 *
 * The input envelope/derivation mirrors `active-docx-edit-tool.ts`
 * (`{version, operations}`, derived from folio's exported
 * `FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA`), with different narrowings:
 * - `severity` / `area` are left exactly as folio declares them (optional):
 *   there is no review panel here to sort/group by them.
 * - `formatRange` IS accepted (unlike the manual tool): this surface makes
 *   no "no formatting changes" promise, and folio supports the operation
 *   directly.
 * - `precondition` (blockTextHash) is still rejected: the model never sees
 *   block text hashes on this surface either, so it could only fabricate
 *   them.
 * - `mode` / `atomic` / `dryRun` are still not accepted from the model, but
 *   for a different reason than the manual tool: the apply representation
 *   is a session-level setting (`docxEditRepresentation`), not a per-call
 *   model argument, so a model-supplied `mode` would silently conflict with
 *   it. The manual tool's rejection message talks about queued review; this
 *   tool's talks about the session setting instead.
 */

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A structural cross-reference cleanup pass can legitimately touch dozens of
// blocks in one turn; this is a sanity ceiling, not a UX limit (mirrors the
// manual tool's own cap).
const MAX_OPERATIONS_PER_BATCH = 200;

type DerivedOperationVariant = {
  operationType: string;
  schema: JsonObject;
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
  const typeEnum: unknown[] | undefined =
    isJsonObject(typeProperty) && Array.isArray(typeProperty["enum"])
      ? typeProperty["enum"]
      : undefined;
  const operationType = typeEnum?.at(0);
  if (typeof operationType !== "string") {
    panic("Missing `type` discriminator in folio operation variant schema");
  }

  const properties: JsonObject = { ...sourceProperties };
  // Narrowing: `precondition` is not accepted on this surface (the model
  // never sees block-text hashes here, so it could only fabricate one).
  delete properties["precondition"];

  // Typed as unknown[]: Array.isArray alone narrows to any[], which the
  // unsafe-any lint rules reject.
  const requiredKeys: unknown[] = sourceRequired;
  // Narrowing: the operation id is optional on this surface; a missing id
  // is auto-generated below before folio's own parser sees it.
  const required = requiredKeys.filter((key) => key !== "id");

  return {
    operationType,
    schema: { ...variant, properties, required },
    propertyKeys: new Set(Object.keys(properties)),
  };
};

const ACCEPTED_OPERATION_VARIANTS =
  FOLIO_DOCUMENT_OPERATION_JSON_SCHEMA.oneOf.map((variant) =>
    deriveOperationVariant(variant),
  );

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
  required: ["operations"],
  additionalProperties: false,
};

const providerSafeInputJsonSchema = projectToProviderSafeJsonSchema(
  inputJsonSchema,
  { nullUnionStrategy: "json-schema" },
).schema;

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
            "`operations` are accepted. The apply representation " +
            "(tracked changes vs. direct) is controlled by the chat " +
            "session's setting, not by the operation batch, so `mode`, " +
            "`atomic`, and `dryRun` cannot be set here.",
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
    issues.push(
      validationIssue(
        "Unknown operation `type`: expected one of " +
          `${[...OPERATION_VARIANTS_BY_TYPE.keys()].join(", ")}.`,
        ["operations", index, "type"],
      ),
    );
    return null;
  }

  const stripped: JsonObject = {};
  for (const key of Object.keys(operation)) {
    if (!variant.propertyKeys.has(key)) {
      issues.push(
        validationIssue(
          `Unexpected property \`${key}\` for operation type ` +
            `\`${variant.operationType}\`.`,
          ["operations", index, key],
        ),
      );
      continue;
    }
    stripped[key] = operation[key];
  }
  return stripped;
};

type WithOptionalOperationId<T> = T extends { id: string }
  ? Omit<T, "id"> & { id?: string }
  : T;

type ValidatedEditWorkspaceDocumentInput = {
  version: typeof FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION;
  operations: WithOptionalOperationId<FolioAIEditOperation>[];
};

const validateEditWorkspaceDocumentInput = (
  input: unknown,
): StandardSchemaV1.Result<ValidatedEditWorkspaceDocumentInput> => {
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

  const parseable: JsonObject[] = [];
  for (const [index, operation] of operations.entries()) {
    const strippedOperation = narrowOperation({ operation, index, issues });
    if (strippedOperation === null) {
      continue;
    }
    parseable.push(strippedOperation);
  }

  if (issues.length > 0) {
    return { issues };
  }

  // No await: folio's batch schema is a synchronous valibot schema (see
  // `active-docx-edit-tool.ts`'s identical comment on this exact call).
  const operationsForValidation = parseable.map((operation, index) =>
    operation["id"] === undefined
      ? { ...operation, id: `validation-${String(index)}` }
      : operation,
  );
  const folioResult = folioDocumentOperationBatchSchema["~standard"].validate({
    version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
    operations: operationsForValidation,
  });
  if (folioResult.issues !== undefined) {
    return { issues: folioResult.issues };
  }

  return {
    value: {
      version: FOLIO_DOCUMENT_OPERATION_CONTRACT_VERSION,
      // SAFETY: folio's strict batch parser just validated every
      // operation's shape against the same contract the derived JSON schema
      // advertises. Missing ids were supplied with deterministic placeholders
      // only for that parser call; the returned shape deliberately preserves
      // their absence so repeated arguments/input validation stays identical.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see the SAFETY note above; the parser validated the exact shape
      operations: parseable as WithOptionalOperationId<FolioAIEditOperation>[],
    },
  };
};

// Both type parameters are the VALIDATED shape, not the raw pre-validation
// one: `StandardSchemaV1`'s `Input` generic is a phantom marker (it never
// appears in the `~standard.validate` signature, which always accepts
// `unknown`), but TanStack's `InferToolInput` reads it nominally to type a
// `.server()` handler's argument. Declaring it as anything narrower than
// the validated type here would leave the handler typed against
// unvalidated data it never actually receives.
type EditWorkspaceDocumentInputToolSchema = StandardJSONSchemaV1<
  ValidatedEditWorkspaceDocumentInput,
  ValidatedEditWorkspaceDocumentInput
> &
  StandardSchemaV1<
    ValidatedEditWorkspaceDocumentInput,
    ValidatedEditWorkspaceDocumentInput
  >;

const inputToolSchema: EditWorkspaceDocumentInputToolSchema = {
  "~standard": {
    version: 1,
    vendor: "stella",
    validate: validateEditWorkspaceDocumentInput,
    jsonSchema: {
      input: () => providerSafeInputJsonSchema,
      output: () => providerSafeInputJsonSchema,
    },
  },
};

// ---------------------------------------------------------------------------
// Output schema: minimal facts only -- no DOCX bytes/base64, no raw entity
// id. `versionId` is the same class of value `compare_versions`' OWN input
// schema already accepts directly from the model (a raw entity version id),
// so returning the id of the version this tool just wrote is no wider a
// surface than that existing tool's accepted input.
// ---------------------------------------------------------------------------

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
  reason: v.picklist(FOLIO_AI_EDIT_SKIP_REASONS),
});

const appliedOperationSchema = v.strictObject({
  id: v.string(),
  commentId: v.optional(v.number()),
  revisionId: v.optional(v.number()),
  revisionIds: v.optional(v.array(v.number())),
});

/**
 * Stable discriminator for the "acting user has no configured author
 * name" outcome. Unlike every other failure on this tool (missing
 * document, all operations skipped, write failure -- all of which throw
 * `ChatToolError` and become opaque model-facing text), this one has a
 * concrete UI remedy: the chat client can detect this exact `code` and
 * open a "set your name" modal inline, then retry the same tool call,
 * instead of just reporting a generic error to the model. This is the
 * first client-branchable structured tool outcome in this codebase (no
 * other chat tool returns one today); every other failure path on this
 * tool is left as a thrown `ChatToolError`, matching existing convention,
 * because none of them have an equivalent one-click UI fix.
 */
export const EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE =
  "author_name_required";

const editWorkspaceDocumentSuccessSchema = v.strictObject({
  success: v.literal(true),
  versionId: v.pipe(
    v.string(),
    v.description(
      "Id of the new document version this tool just wrote. Pass this as " +
        "`revisedVersionId` to `compare_versions` if the user asks what " +
        "changed.",
    ),
  ),
  versionNumber: v.number(),
  representation: v.picklist(Object.values(DOCX_EDIT_REPRESENTATION)),
  applied: v.pipe(
    v.array(appliedOperationSchema),
    v.description(
      "Operations written to the new document version. The document has " +
        "already changed for every id listed here.",
    ),
  ),
  skipped: v.pipe(
    v.array(skippedOperationSchema),
    v.description(
      "Operations that were NOT applied, with why. Tell the user plainly " +
        "what could not be changed; do not retry these operations.",
    ),
  ),
});

const editWorkspaceDocumentAuthorNameRequiredSchema = v.strictObject({
  success: v.literal(false),
  code: v.literal(EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE),
  message: v.string(),
  retryable: v.literal(true),
});

const outputSchema = v.union([
  editWorkspaceDocumentSuccessSchema,
  editWorkspaceDocumentAuthorNameRequiredSchema,
]);

type CreateEditWorkspaceDocumentToolsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  recordAuditEvent: AuditRecorder;
  docxEditRepresentation: DocxEditRepresentation;
};

/**
 * Server-executed `edit_workspace_document` chat tool: the headless
 * (`auto`) counterpart to the manual, client-executed
 * `apply-active-docx-edits`. Applies a versioned document-operation batch
 * directly to the active DOCX (`@stll/folio-core/server`'s
 * `applyFolioAIEditsToBuffer`) and writes the result as a new entity
 * version -- no browser review panel, no per-suggestion accept step.
 *
 * A mutation (writes a new document version), so it is classified
 * `CHAT_TOOL_POLICY_KIND.mutation` in `chat-tools.ts` (needs per-call
 * approval).
 *
 * `entityId` / `workspaceId` are threaded in from the request's
 * server-validated active-file context, never taken from tool input.
 * `docxEditRepresentation` is threaded from the chat session's setting
 * (`chat-schema.ts`), never a model argument (see the module doc comment).
 */
export const createEditWorkspaceDocumentTools = ({
  safeDb,
  organizationId,
  userId,
  workspaceId,
  entityId,
  fileFieldId,
  recordAuditEvent,
  docxEditRepresentation,
}: CreateEditWorkspaceDocumentToolsProps) => ({
  [EDIT_WORKSPACE_DOCUMENT_TOOL_NAME]: toolDefinition({
    name: EDIT_WORKSPACE_DOCUMENT_TOOL_NAME,
    description:
      "Apply edits directly to the DOCX currently open in the document " +
      "editor and save a new version -- no user review step. Use this " +
      "instead of `apply-active-docx-edits` when automatic apply mode is " +
      "active. Send a versioned operation batch: " +
      '`{"version": 1, "operations": [...]}`. The redline representation ' +
      "(tracked changes vs. direct) is fixed for this chat session and " +
      "cannot be chosen per call. Write document prose, not markdown: no " +
      "`#` headings, list dashes, or backticks. For a bold heading set " +
      "`styleId` (e.g. ClauseHeading1). Inserted block `text` may use " +
      "`**bold**` / `***bold italic***` for inline emphasis.",
    inputSchema: inputToolSchema,
    outputSchema: toTanStackToolSchema(outputSchema),
  }).server(async ({ operations }) => {
    const operationsWithIds: FolioAIEditOperation[] = operations.map(
      (operation) => ({
        ...operation,
        id: operation.id ?? `auto-${Bun.randomUUIDv7()}`,
      }),
    );
    const authorName = await resolveDocxEditAuthorName({ safeDb, userId });
    const authorRequired =
      docxEditRepresentation === DOCX_EDIT_REPRESENTATION.trackedChanges ||
      operations.some((operation) => "comment" in operation);
    if (!authorName && authorRequired) {
      // Structured, client-branchable outcome (not a thrown ChatToolError):
      // the chat client detects `code` and opens a "set your name" modal
      // inline, then retries this same call -- see the schema doc comment.
      // No version is written.
      return {
        success: false as const,
        code: EDIT_WORKSPACE_DOCUMENT_AUTHOR_NAME_REQUIRED_CODE,
        message:
          "Set a preferred name in your account settings before using " +
          "automatic document edits: tracked changes and comments must be " +
          "attributed to you, never to a placeholder author.",
        retryable: true as const,
      };
    }

    const loaded = await loadEntityVersionDocxBuffer({
      safeDb,
      organizationId,
      workspaceId,
      entityId,
      fileFieldId,
    });
    if (Result.isError(loaded)) {
      throw new ChatToolError({
        message: loaded.error.message,
        cause: loaded.error,
      });
    }

    const applied = await applyFolioAIEditsToBuffer(
      loaded.value.buffer,
      operationsWithIds,
      {
        author: authorName ?? "",
        mode: docxEditRepresentation,
      },
    );

    if (applied.applied.length === 0) {
      const skippedSummary = applied.skipped
        .map((skip) => `${skip.id} (${skip.reason})`)
        .join(", ");
      throw new ChatToolError({
        message: `No operations could be applied in "${docxEditRepresentation}" mode. Skipped: ${skippedSummary}`,
      });
    }

    const validation = await validateDocxBuffer(applied.buffer);
    if (!validation.valid) {
      throw new ChatToolError({
        message: `The edited document failed validation: ${validation.error}`,
      });
    }

    const written = await createEntityVersionFromBuffer({
      safeDb,
      organizationId,
      workspaceId,
      entityId,
      expectedCurrentVersionId: loaded.value.entityVersionId,
      userId,
      recordAuditEvent,
      buffer: applied.buffer,
      fileName: loaded.value.fileName,
      filePropertyId: loaded.value.filePropertyId,
    });
    if (Result.isError(written)) {
      throw new ChatToolError({
        message: written.error.message,
        cause: written.error,
      });
    }

    return {
      success: true as const,
      versionId: written.value.entityVersionId,
      versionNumber: written.value.versionNumber,
      representation: docxEditRepresentation,
      // Mapped into plain, mutable objects: folio's own
      // `FolioAIEditAppliedOperation`/`FolioAIEditSkippedOperation` types
      // carry a `readonly number[]` for `revisionIds`, which the output
      // schema's inferred (mutable) array type does not structurally
      // accept.
      applied: applied.applied.map((op) => ({
        id: op.id,
        ...(op.commentId !== undefined && { commentId: op.commentId }),
        ...(op.revisionId !== undefined && { revisionId: op.revisionId }),
        ...(op.revisionIds !== undefined && {
          revisionIds: [...op.revisionIds],
        }),
      })),
      skipped: applied.skipped.map((skip) => ({
        id: skip.id,
        reason: skip.reason,
      })),
    };
  }),
});
