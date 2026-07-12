import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import {
  compareDocxVersions,
  formatVersionDiffForLLM,
} from "@stll/folio-agents";

import type { SafeDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import type { AuthorizedToolWorkspaceIds } from "@/api/handlers/chat/tools/authorized-workspace-ids";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { brandPersistedEntityVersionId } from "@/api/lib/safe-id-boundaries";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const COMPARE_VERSIONS_TOOL_NAME = "compare_versions";

const compareVersionsInputSchema = v.strictObject({
  baseVersionId: v.pipe(
    v.string(),
    v.uuid(),
    v.description(
      "Entity version id of the earlier (base) version to compare from.",
    ),
  ),
  revisedVersionId: v.pipe(
    v.string(),
    v.uuid(),
    v.description(
      "Entity version id of the later (revised) version to compare to.",
    ),
  ),
});

const compareVersionsOutputSchema = v.strictObject({
  diff: v.pipe(
    v.string(),
    v.description(
      "Compact, block-level redline between the two versions, formatted " +
        "for reading: a summary-count header line, then one line per added, " +
        "deleted, modified, format-changed, or moved block.",
    ),
  ),
});

type CreateVersionCompareToolsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  activeFileContext: {
    entityId: SafeId<"entity">;
    fileFieldId: SafeId<"field">;
  };
  // Already intersected with the request's accessible set. A version whose
  // workspace is not in this list is treated as not found, so this is the
  // access boundary for the tool: a model cannot diff a version outside the
  // caller's authorized workspaces.
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
};

type ResolvedVersionDocx = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  fileId: string;
};

const isDocxFileContent = (
  content: FieldContent,
): content is Extract<FieldContent, { type: "file" }> =>
  content.type === "file" && content.mimeType === DOCX_MIME_TYPE;

const resolveActiveFilePropertyId = async (
  safeDb: SafeDb,
  toolWorkspaceIds: AuthorizedToolWorkspaceIds,
  activeFileContext: CreateVersionCompareToolsProps["activeFileContext"],
): Promise<SafeId<"property">> => {
  const activeField = await safeDb((tx) =>
    tx.query.fields.findFirst({
      where: {
        id: { eq: activeFileContext.fileFieldId },
        workspaceId: { in: toolWorkspaceIds },
      },
      columns: { content: true, propertyId: true },
      with: {
        entityVersion: { columns: { entityId: true } },
      },
    }),
  );

  if (Result.isError(activeField)) {
    throw new ChatToolError({
      message: "Failed to look up the active file field.",
      cause: activeField.error,
    });
  }
  if (!activeField.value) {
    throw new ChatToolError({
      message: "The active file field was not found in your workspaces.",
    });
  }
  const activeEntityVersion = activeField.value.entityVersion;
  if (!activeEntityVersion) {
    throw new ChatToolError({
      message: "The active file field is missing its document version.",
    });
  }
  if (activeEntityVersion.entityId !== activeFileContext.entityId) {
    throw new ChatToolError({
      message: "The active file field does not belong to this document.",
    });
  }
  if (!isDocxFileContent(activeField.value.content)) {
    throw new ChatToolError({
      message: "The active file field is not a DOCX file.",
    });
  }

  return activeField.value.propertyId;
};

/**
 * Resolve one entity version id to its DOCX file, enforcing that the version
 * lives in one of the caller's authorized workspaces. Throws a
 * `ChatToolError` (surfaced to the model) when the version is unknown, sits
 * outside the authorized set, or holds no DOCX file — never leaking which of
 * those it was beyond "not found in your workspaces".
 */
const resolveVersionDocx = async (
  safeDb: SafeDb,
  toolWorkspaceIds: AuthorizedToolWorkspaceIds,
  versionId: SafeId<"entityVersion">,
  filePropertyId: SafeId<"property">,
  label: string,
): Promise<ResolvedVersionDocx> => {
  const version = await safeDb((tx) =>
    tx.query.entityVersions.findFirst({
      where: {
        id: { eq: versionId },
        workspaceId: { in: toolWorkspaceIds },
      },
      columns: { entityId: true, workspaceId: true },
    }),
  );

  if (Result.isError(version)) {
    throw new ChatToolError({
      message: `Failed to look up the ${label} version.`,
      cause: version.error,
    });
  }
  if (!version.value) {
    throw new ChatToolError({
      message: `The ${label} version was not found in your workspaces.`,
    });
  }

  const field = await safeDb((tx) =>
    tx.query.fields.findFirst({
      where: {
        entityVersionId: { eq: versionId },
        propertyId: { eq: filePropertyId },
      },
      columns: { content: true },
    }),
  );
  if (Result.isError(field)) {
    throw new ChatToolError({
      message: `Failed to load the ${label} version's active file field.`,
      cause: field.error,
    });
  }

  if (!field.value || !isDocxFileContent(field.value.content)) {
    throw new ChatToolError({
      message: `The ${label} version does not contain the active DOCX file.`,
    });
  }

  return {
    entityId: version.value.entityId,
    workspaceId: version.value.workspaceId,
    fileId: field.value.content.id,
  };
};

const loadVersionDocxBuffer = async (
  organizationId: SafeId<"organization">,
  resolved: ResolvedVersionDocx,
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
 * Server-executed `compare_versions` chat tool: diff two entity versions'
 * DOCX files. Resolves each version id to an S3 DOCX buffer after validating
 * it belongs to one of the caller's authorized workspaces, then returns the
 * `@stll/folio-agents` block-level redline as LLM-ready text.
 *
 * Read-only, so classified `CHAT_TOOL_POLICY_KIND.internal` (no approval) in
 * `chat-tools.ts`.
 */
export const createVersionCompareTools = ({
  safeDb,
  organizationId,
  activeFileContext,
  toolWorkspaceIds,
}: CreateVersionCompareToolsProps) => ({
  [COMPARE_VERSIONS_TOOL_NAME]: toolDefinition({
    name: COMPARE_VERSIONS_TOOL_NAME,
    description:
      "Compare two versions of the active document's DOCX file and report " +
      "what changed. Pass the entity version ids for the earlier (base) and " +
      "later (revised) versions; returns a block-level redline (added / " +
      "deleted / modified / format-changed / moved blocks) as readable " +
      "text. Use when the user asks what changed between two versions of " +
      "the active DOCX.",
    inputSchema: toTanStackToolSchema(compareVersionsInputSchema),
    outputSchema: toTanStackToolSchema(compareVersionsOutputSchema),
  }).server(async ({ baseVersionId, revisedVersionId }) => {
    const baseId = brandPersistedEntityVersionId(baseVersionId);
    const revisedId = brandPersistedEntityVersionId(revisedVersionId);
    const filePropertyId = await resolveActiveFilePropertyId(
      safeDb,
      toolWorkspaceIds,
      activeFileContext,
    );

    const [base, revised] = await Promise.all([
      resolveVersionDocx(
        safeDb,
        toolWorkspaceIds,
        baseId,
        filePropertyId,
        "base",
      ),
      resolveVersionDocx(
        safeDb,
        toolWorkspaceIds,
        revisedId,
        filePropertyId,
        "revised",
      ),
    ]);

    if (base.entityId !== revised.entityId) {
      throw new ChatToolError({
        message: "The base and revised versions belong to different documents.",
      });
    }
    if (base.entityId !== activeFileContext.entityId) {
      throw new ChatToolError({
        message:
          "The base and revised versions must belong to the active document.",
      });
    }

    const [baseBuffer, revisedBuffer] = await Promise.all([
      loadVersionDocxBuffer(organizationId, base),
      loadVersionDocxBuffer(organizationId, revised),
    ]);

    const diff = await compareDocxVersions(baseBuffer, revisedBuffer);
    return { diff: formatVersionDiffForLLM(diff) };
  }),
});
