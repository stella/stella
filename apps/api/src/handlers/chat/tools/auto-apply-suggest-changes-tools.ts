import type { StandardJSONSchemaV1 } from "@standard-schema/spec";
import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import { DOCX_SUGGEST_CHANGES_AUTO_APPLY_OPTIONS } from "@stll/api-contract/chat-docx-suggestions";
import {
  createReviewerBridge,
  executeFolioToolCall,
  getFolioToolDefinitions,
  parseSuggestChangesInput,
} from "@stll/folio-agents";
import type {
  FolioAgentBridge,
  FolioAgentToolOptions,
  FolioSuggestChangesOptions,
} from "@stll/folio-agents";
import type { FolioAgentToolInputByName } from "@stll/folio-agents/tool-contract";
import { FolioDocxReviewer } from "@stll/folio-core/server";

import type { SafeDb } from "@/api/db/safe-db";
import {
  DOCX_EDIT_REPRESENTATION,
  type DocxEditRepresentation,
} from "@/api/handlers/chat/chat-schema";
import {
  requireFolioToolDefinition,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/api/handlers/chat/tools/folio-agent-tools";
import { resolveDocxEditAuthorName } from "@/api/handlers/chat/tools/resolve-docx-edit-author-name";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { getScanWarnings, scanFile } from "@/api/lib/file-scan/scan";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * `suggest_changes` in automatic apply mode: the same folio-agents tool the
 * file overlay queues for review in manual mode, executed here on the server
 * against a headless `FolioDocxReviewer` and saved as a new entity version.
 * `chat-tools.ts` registers exactly one of the two variants per turn
 * (`editApplyMode`), never both.
 *
 * Everything model-facing is folio's: the JSON Schema comes from
 * `getFolioToolDefinitions`, the lenient parser from `executeFolioToolCall`,
 * and the batch-level `documentVersion` pin from
 * `FolioSuggestChangesOptions`. This module only adds what the host owns:
 * author resolution, the document load, and the version write.
 */

/**
 * Stable discriminator for the "acting user has no configured author
 * name" outcome. Unlike every other failure on this tool (missing
 * document, all operations skipped, write failure -- all of which throw
 * `ChatToolError` and become opaque model-facing text), this one has a
 * concrete UI remedy: the chat client detects this exact `code` and opens
 * a "set your name" modal inline, then retries the same tool call, instead
 * of just reporting a generic error to the model.
 */
export const SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE = "author_name_required";

const operationIdSchema = v.strictObject({ id: v.string() });

const skippedOperationSchema = v.strictObject({
  id: v.string(),
  reason: v.string(),
});

const normalizationSchema = v.strictObject({
  path: v.string(),
  message: v.string(),
});

// ---------------------------------------------------------------------------
// Output schema: minimal facts only -- no DOCX bytes/base64, no raw entity
// id. `versionId` is the same class of value `compare_versions`' OWN input
// schema already accepts directly from the model (a raw entity version id),
// so returning the id of the version this tool just wrote is no wider a
// surface than that existing tool's accepted input.
// ---------------------------------------------------------------------------

const autoApplySuggestChangesSuccessSchema = v.strictObject({
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
  fieldId: v.pipe(
    v.string(),
    v.description("Field id of the newly written document version."),
  ),
  replacedFieldId: v.pipe(
    v.string(),
    v.description(
      "Field id this version replaced. The client uses this to keep the " +
        "open document tab and file-chat thread attached to the new version.",
    ),
  ),
  representation: v.picklist(Object.values(DOCX_EDIT_REPRESENTATION)),
  applied: v.pipe(
    v.array(operationIdSchema),
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
  normalizations: v.pipe(
    v.array(normalizationSchema),
    v.description(
      "Input shapes that were tolerated and read as something else. Send " +
        "the documented shape next time.",
    ),
  ),
});

const autoApplySuggestChangesAuthorNameRequiredSchema = v.strictObject({
  success: v.literal(false),
  code: v.literal(SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE),
  message: v.string(),
  retryable: v.literal(true),
});

const outputSchema = v.variant("success", [
  autoApplySuggestChangesSuccessSchema,
  autoApplySuggestChangesAuthorNameRequiredSchema,
]);

export type AutoApplySuggestChangesOutput = v.InferOutput<typeof outputSchema>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether an incoming assistant message answers an approval request on
 * `suggest_changes`. Only the apply variant ever requests approval, so such
 * a turn must run in `auto` mode whatever the composer currently selects:
 * under the queue registration the approved call would wait for a client
 * result that never comes.
 */
export const hasSuggestChangesApprovalResponse = (
  parts: readonly unknown[],
): boolean =>
  parts.some(
    (part) =>
      isPlainObject(part) &&
      part["type"] === "tool-call" &&
      part["name"] === SUGGEST_CHANGES_TOOL_NAME &&
      part["state"] === "approval-responded",
  );

type SuggestChangesArgs =
  FolioAgentToolInputByName[typeof SUGGEST_CHANGES_TOOL_NAME];

/**
 * Folio's raw JSON Schema carried as a Standard JSON Schema, so TanStack
 * types the server handler's input as folio's own argument contract. No
 * `validate` member on purpose: the provider enforces the JSON Schema and
 * folio's lenient parser is the runtime validator, exactly as on the
 * client-executed surfaces.
 */
const toStandardJsonSchema = (
  jsonSchema: Record<string, unknown>,
): StandardJSONSchemaV1<SuggestChangesArgs, SuggestChangesArgs> => ({
  "~standard": {
    version: 1,
    vendor: "stella",
    jsonSchema: {
      input: () => jsonSchema,
      output: () => jsonSchema,
    },
  },
});

/** The auto-apply surface's options with the request's version pin attached. */
const buildAutoApplyOptions = (
  expectedCurrentVersionId: SafeId<"entityVersion">,
): FolioSuggestChangesOptions => ({
  ...DOCX_SUGGEST_CHANGES_AUTO_APPLY_OPTIONS,
  documentVersion: { current: expectedCurrentVersionId },
});

const AUTO_APPLY_DESCRIPTION_SUFFIX =
  " In this session the operations are applied directly and saved as a new " +
  "document version: there is no review step after your call. The " +
  "representation (tracked changes or direct rewrite) is fixed by the " +
  "user's chat setting, not chosen per call. Write document prose, not " +
  "markdown: no `#` headings, list dashes, or backticks. For a bold heading " +
  "set `styleId` (e.g. ClauseHeading1). Inserted block `text` may use " +
  "`**bold**` / `***bold italic***` for inline emphasis.";

/**
 * Whether the batch needs a real author before it may be written: every
 * tracked change is attributed to one, and so is every comment even in
 * direct mode. Parsed with folio's own lenient decoder so the check sees
 * exactly the operations the executor will see.
 */
const requiresAuthor = (
  input: unknown,
  representation: DocxEditRepresentation,
  options: FolioSuggestChangesOptions,
): boolean => {
  if (representation === DOCX_EDIT_REPRESENTATION.trackedChanges) {
    return true;
  }
  const parsed = parseSuggestChangesInput(input, options);
  // A shape the parser rejects never reaches the document; the executor
  // reports that failure to the model without needing an author.
  // The operation union has no "carries a comment" discriminator: the field
  // is optional on the edit variants and required on the comment variants.
  return (
    parsed.ok && parsed.operations.some((operation) => "comment" in operation)
  );
};

export type CreateAutoApplySuggestChangesToolsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  recordAuditEvent: AuditRecorder;
  docxEditRepresentation: DocxEditRepresentation;
  expectedCurrentVersionId: SafeId<"entityVersion">;
  createEntityVersionFromBuffer?: typeof createEntityVersionFromBuffer;
  getScanWarnings?: typeof getScanWarnings;
  scanFile?: typeof scanFile;
};

/**
 * Server-executed `suggest_changes` for the `auto` review mode. Applies the
 * batch through folio's reviewer bridge (`createReviewerBridge` over
 * `FolioDocxReviewer`), then validates, scans, and writes the result as a
 * new entity version -- no browser review panel, no per-suggestion accept
 * step.
 *
 * A mutation (writes a new document version), so it is classified
 * `CHAT_TOOL_POLICY_KIND.mutation` (needs per-call approval). The batch is
 * pinned to `expectedCurrentVersionId` through folio's `documentVersion`
 * precondition: the model must echo it, and the bridge reports the loaded
 * version at apply time, so an approval that lands after the document moved
 * on skips as a whole instead of writing on top of a version the model never
 * saw. The version write re-checks the same id transactionally.
 *
 * `entityId` / `workspaceId` are threaded in from the request's
 * server-validated active-file context, never taken from tool input.
 * `docxEditRepresentation` is threaded from the chat session's setting
 * (`chat-schema.ts`), never a model argument.
 */
export const createAutoApplySuggestChangesTools = ({
  safeDb,
  organizationId,
  userId,
  workspaceId,
  entityId,
  fileFieldId,
  recordAuditEvent,
  docxEditRepresentation,
  expectedCurrentVersionId,
  createEntityVersionFromBuffer: createVersion = createEntityVersionFromBuffer,
  getScanWarnings: getWarnings = getScanWarnings,
  scanFile: scan = scanFile,
}: CreateAutoApplySuggestChangesToolsProps) => {
  const suggestChanges = buildAutoApplyOptions(expectedCurrentVersionId);
  const toolOptions: FolioAgentToolOptions = { suggestChanges };
  const definition = requireFolioToolDefinition(
    getFolioToolDefinitions(toolOptions),
    SUGGEST_CHANGES_TOOL_NAME,
  );

  return {
    [SUGGEST_CHANGES_TOOL_NAME]: toolDefinition({
      name: definition.name,
      description: `${definition.description}${AUTO_APPLY_DESCRIPTION_SUFFIX}`,
      inputSchema: toStandardJsonSchema(definition.inputSchema),
      outputSchema: toTanStackToolSchema(outputSchema),
    }).server(async (input): Promise<AutoApplySuggestChangesOutput> => {
      const authorName = await resolveDocxEditAuthorName({ safeDb, userId });
      if (
        !authorName &&
        requiresAuthor(input, docxEditRepresentation, suggestChanges)
      ) {
        // Structured, client-branchable outcome (not a thrown ChatToolError):
        // the chat client detects `code` and opens a "set your name" modal
        // inline, then retries this same call. No version is written.
        return {
          success: false,
          code: SUGGEST_CHANGES_AUTHOR_NAME_REQUIRED_CODE,
          message:
            "Set a preferred name in your account settings before using " +
            "automatic document edits: tracked changes and comments must be " +
            "attributed to you, never to a placeholder author.",
          retryable: true,
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
          kind: "server-defect",
          message: loaded.error.message,
          cause: loaded.error,
        });
      }

      const reviewer = await FolioDocxReviewer.fromBuffer(loaded.value.buffer, {
        author: authorName ?? "",
      });
      // The reviewer bridge has no version notion of its own; the loaded
      // entity version is the host's, and folio compares the model's
      // `documentVersion` pin against it before applying anything.
      const bridge: FolioAgentBridge = Object.assign(
        createReviewerBridge(reviewer, { mode: docxEditRepresentation }),
        { getDocumentVersion: () => loaded.value.entityVersionId },
      );
      const executed = executeFolioToolCall(
        SUGGEST_CHANGES_TOOL_NAME,
        input,
        bridge,
        toolOptions,
      );
      if (!executed.ok) {
        throw new ChatToolError({
          kind: "invalid-input",
          message: executed.error,
        });
      }
      const summary = executed.result;
      if (summary.applied.length === 0) {
        const skippedSummary = summary.skipped
          .map((skip) => `${skip.id}: ${skip.reason}`)
          .join("; ");
        throw new ChatToolError({
          kind: "invalid-input",
          message: `No operations could be applied in "${docxEditRepresentation}" mode. Skipped: ${skippedSummary}`,
        });
      }

      const edited = await reviewer.toBuffer();
      const validation = await validateDocxBuffer(edited);
      if (!validation.valid) {
        throw new ChatToolError({
          kind: "invalid-input",
          message: `The edited document failed validation: ${validation.error}`,
        });
      }

      const scanResult = await scan({
        buffer: new Uint8Array(edited),
        declaredMimeType: DOCX_MIME_TYPE,
        fileName: loaded.value.fileName,
      });
      if (Result.isError(scanResult)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: "The edited document security scan failed",
          cause: scanResult.error,
        });
      }
      if (scanResult.value.verdict === "reject") {
        const reasons = scanResult.value.findings.flatMap((finding) =>
          finding.severity === "reject" ? [finding.message] : [],
        );
        throw new ChatToolError({
          kind: "invalid-input",
          message: `The edited document was rejected: ${reasons.join("; ")}`,
        });
      }
      const scanWarnings = getWarnings(scanResult.value) ?? undefined;

      const writeAttempt = await Result.tryPromise({
        try: async () =>
          await createVersion({
            safeDb,
            organizationId,
            workspaceId,
            entityId,
            userId,
            recordAuditEvent,
            buffer: edited,
            fileName: loaded.value.fileName,
            mimeType: DOCX_MIME_TYPE,
            source: null,
            writePolicy: {
              type: "automatic-docx-edit",
              expectedCurrentVersionId,
              filePropertyId: loaded.value.filePropertyId,
              replacedFileFieldId: fileFieldId,
            },
            scanWarnings,
          }),
        catch: (cause) =>
          new ChatToolError({
            kind: "server-defect",
            message: "The edited document could not be persisted",
            cause,
          }),
      });
      if (Result.isError(writeAttempt)) {
        throw writeAttempt.error;
      }
      const written = writeAttempt.value;
      if (Result.isError(written)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: written.error.message,
          cause: written.error,
        });
      }

      return {
        success: true,
        versionId: written.value.entityVersionId,
        versionNumber: written.value.versionNumber,
        fieldId: written.value.fieldId,
        replacedFieldId: fileFieldId,
        representation: docxEditRepresentation,
        applied: summary.applied.map(({ id }) => ({ id })),
        skipped: summary.skipped.map(({ id, reason }) => ({ id, reason })),
        normalizations: summary.normalizations.map(({ path, message }) => ({
          path,
          message,
        })),
      };
    }),
  };
};
