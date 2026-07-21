import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  mergeDocumentContent,
} from "@stll/folio-core";
import { fromMarkdown } from "@stll/folio-core/markdown";

import type { ScopedDb } from "@/api/db/safe-db";
import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { buildCreatedDocumentToolOutput } from "@/api/handlers/chat/tools/workspace-tools";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError, unreachable } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const CREATE_WORKSPACE_DOCUMENT_TOOL_NAME = "create_workspace_document";

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

/**
 * Compose a Markdown body into a Stella-styled DOCX byte buffer.
 *
 * `fromMarkdown` (browser/DOM-free `@stll/folio-core/markdown` entry) parses
 * the markdown into its own `createEmptyDocument()` — no style preset, and
 * its page geometry is flattened to a continuous band (see the folio-core
 * doc comment: that flattening targets the skills markdown bridge, where a
 * skill body is not a paginated Word page). We only want its parsed content
 * blocks, not that document shell.
 *
 * So the target document is built separately via
 * `createEmptyDocument({ preset: createStellaStyleDocumentPreset() })` —
 * the same call `create-template-buffer.ts` uses for the blank-document
 * tools — which carries Stella's style set, numbering, font table, and A4
 * section/page geometry. `mergeDocumentContent` appends the parsed markdown
 * blocks onto that document's body, renumbering their lists strictly above
 * Stella's preset numbering (which reserves `numId` 1-5 for its own legal
 * clause / definitions / recitals / parties / bullet lists) so a markdown
 * list never collides with and silently renders as Stella's clause
 * numbering.
 */
export const markdownToStellaDocx = async (
  markdown: string,
): Promise<ArrayBuffer> => {
  const target = createEmptyDocument({
    preset: createStellaStyleDocumentPreset(),
  });
  const merged = mergeDocumentContent(target, fromMarkdown(markdown));
  return await createDocx(merged);
};

type CreateWorkspaceDocumentToolsProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  refRegistry: ChatRefRegistry;
};

const toChatToolError = (
  error:
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" },
): ChatToolError => {
  switch (error._tag) {
    case "EntityLimitError":
      return new ChatToolError({
        message:
          "This matter has reached the document limit, so the document could not be created.",
      });
    case "MissingFilePropertyError":
      return new ChatToolError({
        message:
          "This matter is missing a file property, so the document could not be created.",
      });
    case "InvalidParentError":
      // This tool never sets a parentId (it always creates at the
      // workspace root), so `createEntityFromBuffer` cannot raise this.
      return unreachable(
        "create_workspace_document never sets a parentId, so InvalidParentError is unreachable",
      );
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};

/**
 * Server-executed `create_workspace_document` chat tool: renders a Markdown
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
}: CreateWorkspaceDocumentToolsProps) => ({
  [CREATE_WORKSPACE_DOCUMENT_TOOL_NAME]: toolDefinition({
    name: CREATE_WORKSPACE_DOCUMENT_TOOL_NAME,
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
      throw new ChatToolError({ message: "Document title cannot be blank." });
    }

    const buffer = await markdownToStellaDocx(markdown);

    const created = await createEntityFromBuffer({
      scopedDb,
      organizationId,
      workspaceId,
      userId,
      recordAuditEvent,
      buffer,
      fileName: `${trimmedTitle}.docx`,
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
