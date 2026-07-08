import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import * as v from "valibot";

import {
  compareDocxVersions,
  formatVersionDiffForLLM,
} from "@stll/folio-agents";

import type { SafeDb } from "@/api/db";
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
        "deleted, or modified block.",
    ),
  ),
});

type CreateVersionCompareToolsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  // Already intersected with the request's accessible set. A version whose
  // workspace is not in this list is treated as not found, so this is the
  // access boundary for the tool: a model cannot diff a version outside the
  // caller's authorized workspaces.
  toolWorkspaceIds: AuthorizedToolWorkspaceIds;
};

type ResolvedVersionDocx = {
  workspaceId: SafeId<"workspace">;
  fileId: string;
};

const findDocxFile = (
  fieldList: readonly { content: FieldContent }[],
): Extract<FieldContent, { type: "file" }> | null => {
  for (const field of fieldList) {
    if (
      field.content.type === "file" &&
      field.content.mimeType === DOCX_MIME_TYPE
    ) {
      return field.content;
    }
  }
  return null;
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
  label: string,
): Promise<ResolvedVersionDocx> => {
  const version = await safeDb((tx) =>
    tx.query.entityVersions.findFirst({
      where: {
        id: { eq: versionId },
        workspaceId: { in: toolWorkspaceIds },
      },
      columns: { workspaceId: true },
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

  const fields = await safeDb((tx) =>
    // SAFETY: one version's fields, bounded by LIMITS.propertiesCount via the
    // unique (propertyId, entityVersionId) index.
    // eslint-disable-next-line require-query-limit/require-query-limit
    tx.query.fields.findMany({
      where: { entityVersionId: { eq: versionId } },
      columns: { content: true },
    }),
  );
  if (Result.isError(fields)) {
    throw new ChatToolError({
      message: `Failed to load the ${label} version's fields.`,
      cause: fields.error,
    });
  }

  const file = findDocxFile(fields.value);
  if (!file) {
    throw new ChatToolError({
      message: `The ${label} version does not contain a DOCX file.`,
    });
  }

  return { workspaceId: version.value.workspaceId, fileId: file.id };
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
  toolWorkspaceIds,
}: CreateVersionCompareToolsProps) => ({
  [COMPARE_VERSIONS_TOOL_NAME]: toolDefinition({
    name: COMPARE_VERSIONS_TOOL_NAME,
    description:
      "Compare two versions of the same document and report what changed. " +
      "Pass the entity version ids for the earlier (base) and later " +
      "(revised) versions; returns a block-level redline (added / deleted / " +
      "modified blocks) as readable text. Use when the user asks what " +
      "changed between two versions of a DOCX.",
    inputSchema: toTanStackToolSchema(compareVersionsInputSchema),
    outputSchema: toTanStackToolSchema(compareVersionsOutputSchema),
  }).server(async ({ baseVersionId, revisedVersionId }) => {
    const baseId = brandPersistedEntityVersionId(baseVersionId);
    const revisedId = brandPersistedEntityVersionId(revisedVersionId);

    const [base, revised] = await Promise.all([
      resolveVersionDocx(safeDb, toolWorkspaceIds, baseId, "base"),
      resolveVersionDocx(safeDb, toolWorkspaceIds, revisedId, "revised"),
    ]);

    const [baseBuffer, revisedBuffer] = await Promise.all([
      loadVersionDocxBuffer(organizationId, base),
      loadVersionDocxBuffer(organizationId, revised),
    ]);

    const diff = await compareDocxVersions(baseBuffer, revisedBuffer);
    return { diff: formatVersionDiffForLLM(diff) };
  }),
});
