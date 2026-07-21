import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import { docxToMarkdown } from "@stll/folio-core/server";

import type { SafeDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
} from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const READ_WORKSPACE_DOCUMENT_TOOL_NAME = "read_workspace_document";

const readWorkspaceDocumentInputSchema = v.strictObject({
  entityId: v.pipe(
    v.string(),
    v.uuid(),
    v.description("Entity id of the document to read."),
  ),
  versionId: v.optional(
    v.pipe(
      v.string(),
      v.uuid(),
      v.description(
        "Specific entity version id to read. Omit to read the document's " +
          "current version.",
      ),
    ),
  ),
});

const readWorkspaceDocumentOutputSchema = v.strictObject({
  markdown: v.pipe(
    v.string(),
    v.description(
      `The document's DOCX content converted to Markdown (headings, tables, ` +
        `lists, and content controls preserved), capped at ` +
        `${String(LIMITS.chatContextFileMaxChars)} characters.`,
    ),
  ),
});

type CreateReadWorkspaceDocumentToolsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  // The access boundary for this tool: an entity or version whose workspace
  // is not in this list is treated as not found, so a model can never read a
  // document outside the caller's authorized workspaces.
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
};

type ResolvedDocumentDocx = {
  workspaceId: SafeId<"workspace">;
  fileId: string;
};

const isDocxFileContent = (
  content: FieldContent,
): content is Extract<FieldContent, { type: "file" }> =>
  content.type === "file" && content.mimeType === DOCX_MIME_TYPE;

/**
 * Resolve an entity id (with no version id given) to its current version id,
 * enforcing that the entity lives in one of the caller's authorized
 * workspaces. Throws a `ChatToolError` when the entity is unknown, sits
 * outside the authorized set, or has no current version.
 */
const resolveCurrentVersionId = async (
  safeDb: SafeDb,
  toolWorkspaceIds: AuthorizedToolWorkspaceIds,
  entityId: SafeId<"entity">,
): Promise<SafeId<"entityVersion">> => {
  const entity = await safeDb((tx) =>
    tx.query.entities.findFirst({
      where: {
        id: { eq: entityId },
        workspaceId: { in: toolWorkspaceIds },
      },
      columns: { currentVersionId: true },
    }),
  );

  if (Result.isError(entity)) {
    throw new ChatToolError({
      message: "Failed to look up the document.",
      cause: entity.error,
    });
  }
  if (!entity.value) {
    throw new ChatToolError({
      message: "The document was not found in your workspaces.",
    });
  }
  if (!entity.value.currentVersionId) {
    throw new ChatToolError({
      message: "The document has no current version to read.",
    });
  }

  return entity.value.currentVersionId;
};

/**
 * Resolve one entity version id to its DOCX file, enforcing that the version
 * lives in one of the caller's authorized workspaces and belongs to the
 * given entity. Throws a `ChatToolError` (surfaced to the model) when the
 * version is unknown, sits outside the authorized set, or holds no DOCX file
 * — never leaking which of those it was beyond "not found in your
 * workspaces".
 */
const resolveDocumentDocx = async (
  safeDb: SafeDb,
  toolWorkspaceIds: AuthorizedToolWorkspaceIds,
  entityId: SafeId<"entity">,
  versionId: SafeId<"entityVersion">,
): Promise<ResolvedDocumentDocx> => {
  // Read the version and its fields in one tombstone-checked query. Reading
  // fields separately after the version's `deletedAt IS NULL` check would
  // leave a TOCTOU window: a tombstone landing between the two reads would
  // still hand a withdrawn version's DOCX to the model.
  const version = await safeDb((tx) =>
    tx.query.entityVersions.findFirst({
      where: {
        id: { eq: versionId },
        entityId: { eq: entityId },
        workspaceId: { in: toolWorkspaceIds },
        // Tombstoned versions are withdrawn: never resolvable for AI reads.
        deletedAt: { isNull: true },
      },
      columns: { workspaceId: true },
      with: { fields: { columns: { content: true } } },
    }),
  );

  if (Result.isError(version)) {
    throw new ChatToolError({
      message: "Failed to look up the document version.",
      cause: version.error,
    });
  }
  if (!version.value) {
    throw new ChatToolError({
      message: "The document version was not found in your workspaces.",
    });
  }

  const file = version.value.fields
    .map((field) => field.content)
    .find(isDocxFileContent);

  if (!file) {
    throw new ChatToolError({
      message: "The document version does not contain a DOCX file.",
    });
  }

  return { workspaceId: version.value.workspaceId, fileId: file.id };
};

const loadDocumentDocxBuffer = async (
  organizationId: SafeId<"organization">,
  resolved: ResolvedDocumentDocx,
): Promise<ArrayBuffer> =>
  await getS3()
    .file(
      createFileKey({
        organizationId,
        workspaceId: resolved.workspaceId,
        fileId: resolved.fileId,
        mimeType: DOCX_MIME_TYPE,
      }),
    )
    .arrayBuffer();

/**
 * Server-executed `read_workspace_document` chat tool: read a workspace
 * document's DOCX content as Markdown. Resolves an entity id (and optional
 * version id, defaulting to the current version) to an S3 DOCX buffer after
 * validating it belongs to one of the caller's authorized workspaces, then
 * returns folio's structure-preserving Markdown extraction (headings,
 * tables, lists, content controls), capped at
 * `LIMITS.chatContextFileMaxChars`.
 *
 * Distinct from the folio-agents `read_document` tool registered in
 * `folio-agent-tools.ts`: that one is client-executed against the *live
 * DOCX editor* for the active file only, gated on `hasActiveDocxFileClient`.
 * This tool is server-executed and can read any authorized document by id
 * — including documents other than the one currently open — so it is
 * always registered when the caller has at least one accessible workspace.
 *
 * Read-only, so classified `CHAT_TOOL_POLICY_KIND.internal` (no approval) in
 * `chat-tools.ts`.
 */
export const createReadWorkspaceDocumentTools = ({
  safeDb,
  organizationId,
  toolWorkspaceIds,
}: CreateReadWorkspaceDocumentToolsProps) => ({
  [READ_WORKSPACE_DOCUMENT_TOOL_NAME]: toolDefinition({
    name: READ_WORKSPACE_DOCUMENT_TOOL_NAME,
    description:
      "Read a workspace document's content as Markdown, converted from its " +
      "DOCX file with structure preserved (headings, tables, lists, content " +
      "controls). Pass the document's entity id; optionally pass a specific " +
      "entityVersionId to read a past version instead of the current one. " +
      "Use this to pull any authorized document into context on demand — " +
      "not only the one the user currently has open.",
    inputSchema: toTanStackToolSchema(readWorkspaceDocumentInputSchema),
    outputSchema: toTanStackToolSchema(readWorkspaceDocumentOutputSchema),
  }).server(async ({ entityId, versionId }) => {
    const brandedEntityId = brandPersistedEntityId(entityId);
    const brandedVersionId =
      versionId === undefined
        ? await resolveCurrentVersionId(
            safeDb,
            toolWorkspaceIds,
            brandedEntityId,
          )
        : brandPersistedEntityVersionId(versionId);

    const resolved = await resolveDocumentDocx(
      safeDb,
      toolWorkspaceIds,
      brandedEntityId,
      brandedVersionId,
    );

    const buffer = await loadDocumentDocxBuffer(organizationId, resolved);

    let markdown: string;
    try {
      markdown = await docxToMarkdown(buffer);
    } catch (error) {
      throw new ChatToolError({
        message: "Failed to convert the document to Markdown.",
        cause: error,
      });
    }

    return { markdown: markdown.slice(0, LIMITS.chatContextFileMaxChars) };
  }),
});
