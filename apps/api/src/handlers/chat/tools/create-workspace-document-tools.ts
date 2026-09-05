import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import type { ScopedDb } from "@/api/db/safe-db";
import { CREATE_MATTER_DOCUMENT_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { buildCreatedDocumentToolOutput } from "@/api/handlers/chat/tools/workspace-tools";
import { captureError } from "@/api/lib/analytics/capture";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { ChatToolError, unreachable } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export { CREATE_MATTER_DOCUMENT_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";

const createWorkspaceDocumentInputSchema = v.strictObject({
  // Not `v.trim()`: the OpenAI/Anthropic/... adapters' JSON Schema converter
  // (`@valibot/to-json-schema`) cannot express the `trim` action, so a tool
  // input schema carrying it fails to serialize into any provider request.
  // Trimmed manually in the executor instead.
  title: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(256),
    v.description("Document file name, without the .docx extension."),
  ),
  markdown: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.chatContextFileMaxChars),
    v.description(
      "The document body as GitHub-flavoured markdown: headings (#, up to " +
        "####), paragraphs, bold/italic/strikethrough, inline code, bullet " +
        "and numbered lists (incl. nesting), pipe tables, blockquotes, and " +
        "links. Rendered into a paginated DOCX using stella's house style " +
        "(fonts, spacing, numbering) — do not attempt manual page layout.",
    ),
  ),
});

export type CreateWorkspaceDocumentInput = v.InferOutput<
  typeof createWorkspaceDocumentInputSchema
>;

// Mirrors the shape `buildCreatedDocumentToolOutput` returns (fileName +
// ref-mediated mention fields) — the same output the client-executed
// `create-document` tool and the `create-from-legal-source` REST endpoint
// use, so the model links to the new document the same way everywhere. No
// raw `entityId` / `entityVersionId` is included: the codebase's chat tools
// never hand the model a raw tenant UUID (see `ChatRefRegistry`'s
// dehydrate/hydrate boundary), so those stay server-side.
const createWorkspaceDocumentOutputSchema = v.strictObject({
  success: v.literal(true),
  fileName: v.string(),
  entityRef: v.string(),
  matterRef: v.string(),
  href: v.string(),
  mention: v.string(),
});

type CreateWorkspaceDocumentToolsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  refRegistry: ChatRefRegistry;
  createEntityFromBuffer?: typeof createEntityFromBuffer;
};

const toChatToolError = (
  error:
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" },
): ChatToolError => {
  switch (error._tag) {
    case "DocumentTooLargeError":
      return new ChatToolError({
        kind: "limit",
        message:
          "The generated document exceeds stella's document size limit, so it could not be created.",
      });
    case "EntityLimitError":
      return new ChatToolError({
        kind: "limit",
        message:
          "This matter has reached the document limit, so the document could not be created.",
      });
    case "MissingFilePropertyError":
      return new ChatToolError({
        kind: "server-defect",
        message:
          "This matter is missing a file property, so the document could not be created.",
      });
    case "InvalidParentError":
      // This tool never sets a parentId (it always creates at the
      // workspace root), so `createEntityFromBuffer` cannot raise this.
      return unreachable(
        "create_matter_document never sets a parentId, so InvalidParentError is unreachable",
      );
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};

/**
 * Server-executed `create_matter_document` chat tool: renders a Markdown
 * body into a Stella-styled DOCX and creates it as a new entity/version in
 * the caller's active matter, via the same `createEntityFromBuffer` path the
 * upload handler and `create-from-legal-source` REST endpoint use.
 *
 * A mutation (creates data), so it is classified
 * `CHAT_TOOL_POLICY_KIND.mutation` in `chat-tools.ts` (needs approval).
 *
 * `workspaceId` is threaded in from the request's server-validated active
 * matter context (`requestWorkspaceId`), never taken from tool input — the
 * model has no way to choose or forge a destination workspace. `chat-tools.ts`
 * only registers this tool when a single matter is pinned for the thread
 * (`requestWorkspaceId !== null`) and an audit recorder is available; there is
 * no folder/parent targeting yet, so every document lands at the matter root.
 */
export const createCreateWorkspaceDocumentTools = ({
  scopedDb,
  organizationId,
  userId,
  workspaceId,
  recordAuditEvent,
  refRegistry,
  createEntityFromBuffer: createEntity = createEntityFromBuffer,
}: CreateWorkspaceDocumentToolsProps) => ({
  [CREATE_MATTER_DOCUMENT_TOOL_NAME]: toolDefinition({
    name: CREATE_MATTER_DOCUMENT_TOOL_NAME,
    description:
      "Create a brand-new DOCX in the active matter from a Markdown body, " +
      "rendered with stella's house style (fonts, spacing, list numbering). " +
      "Runs immediately in the active matter (after user approval) — unlike " +
      "`create-document`, there is no destination-matter picker, so only use " +
      "this when a matter is already active. Does NOT edit, convert, or " +
      "preserve formatting from an existing DOCX; never use it when the user " +
      "asks to edit, rewrite, save, update, or make a new version of an " +
      "already-open document. On success, copy the `mention` field verbatim " +
      "when naming the document in your reply.",
    inputSchema: toTanStackToolSchema(createWorkspaceDocumentInputSchema),
    outputSchema: toTanStackToolSchema(createWorkspaceDocumentOutputSchema),
  }).server(async ({ title, markdown }) => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      throw new ChatToolError({
        kind: "invalid-input",
        message: "Document title cannot be blank.",
      });
    }

    const docxResult = await markdownToStellaDocx(markdown);
    if (Result.isError(docxResult)) {
      captureError(docxResult.error, {
        source: "create_matter_document",
      });
      throw new ChatToolError({
        kind: "server-defect",
        message: "The document body could not be converted to DOCX.",
        cause: docxResult.error,
      });
    }

    // Sanitized the same way `create-from-legal-source`'s REST handler
    // sanitizes its own model/user-supplied title before building a
    // filename: strips characters that are invalid in a filename or could
    // inject into Content-Disposition (`/ \ ? % * : | " < >` and friends),
    // rather than passing the model's title straight into a stored path.
    const fileName = sanitizeFilenamePreservingExtension(
      `${trimmedTitle}.docx`,
    );

    const created = await createEntity({
      scopedDb,
      organizationId,
      workspaceId,
      userId,
      recordAuditEvent,
      buffer: docxResult.value,
      fileName,
      mimeType: DOCX_MIME_TYPE,
      parentId: null,
    });

    if (Result.isError(created)) {
      throw toChatToolError(created.error);
    }

    return buildCreatedDocumentToolOutput({
      entityId: created.value.entityId,
      fileName: created.value.fileName,
      refRegistry,
      workspaceId,
    });
  }),
});
