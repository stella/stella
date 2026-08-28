/**
 * Everything a position proposal needs before a model is asked anything: the
 * documents resolved and access-checked, fetched, parsed into blocks, and the
 * organization's usage confirmed.
 *
 * Shared by both proposal endpoints. The batch endpoint answers with the whole
 * plan; the streaming one reports it term by term. Neither may reach the model
 * on a matter the caller cannot open, so the checks live here once rather than
 * in each handler.
 */

import { panic, Result } from "better-result";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import type { ReferenceSource } from "@/api/handlers/document-reviews/reference-position-normalizer";
import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import type { proposeReviewPositionsBodySchema } from "@/api/handlers/document-reviews/schemas";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { fetchAndPrepareReviewFiles } from "@/api/lib/document-review/prepare-review-files";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import { findDuplicatePositionSourceId } from "@/api/lib/workflow/playbook-positions-validation";

export type ProposalBody = Static<typeof proposeReviewPositionsBodySchema>;

export type PreparedProposal = {
  target: PreparedDocxFile;
  references: ReferenceSource[];
  targetEntityVersionId: SafeId<"entityVersion">;
};

export type PrepareProposalArgs = {
  body: ProposalBody;
  orgAIConfig: OrgAIConfig | null;
  orgAIConfigStatus: OrgAIConfigStatus;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const prepareReferenceProposal = async function* ({
  body,
  orgAIConfig,
  orgAIConfigStatus,
  organizationId,
  safeDb,
  userId,
  workspaceId,
}: PrepareProposalArgs): SafeHandlerGenerator<PreparedProposal> {
  const duplicateSourceId = findDuplicatePositionSourceId({
    version: 3,
    items: body.seededPositions,
  });
  if (duplicateSourceId !== null) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Positions must have unique sourceIds",
      }),
    );
  }
  yield* requireTanStackAIAvailableForRole({
    configStatus: orgAIConfigStatus,
    orgConfig: orgAIConfig,
    role: "pdf",
  });

  const targetRef = { ...body.target, workspaceId };
  const entityIds = [
    targetRef.entityId,
    ...body.references.map((reference) => reference.entityId),
  ];
  // Same cross-matter rule as run creation: the membership-scoped read returns
  // only matters the caller can see, and the selection holds each row to the
  // matter its reference named.
  const loadedEntities = yield* Result.await(
    safeDb((tx) =>
      tx.query.entities.findMany({
        where: { id: { in: [...new Set(entityIds)] } },
        columns: { id: true, workspaceId: true },
        limit: body.references.length + 1,
        with: {
          currentVersion: {
            columns: { id: true },
            with: {
              fields: { columns: { id: true, content: true } },
            },
          },
        },
      }),
    ),
  );
  const selection = resolveReviewSelection({
    target: targetRef,
    references: body.references,
    entities: loadedEntities,
  });
  if (Result.isError(selection)) {
    return Result.err(selection.error);
  }

  const preflightError = await assertUsageAvailableForHandler({
    metering: { actionType: "chat", modelRole: "pdf" },
    organizationId,
    orgAIConfig,
    workspaceId,
    userId,
    safeDb,
  });
  if (preflightError) {
    return Result.err(preflightError);
  }

  const resolvedFiles = [
    selection.value.target,
    ...selection.value.references,
  ].map((document) => document.file);
  const preparedResult = await Result.tryPromise({
    try: async () =>
      await fetchAndPrepareReviewFiles(resolvedFiles, organizationId),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Internal server error",
        cause,
      }),
  });
  if (Result.isError(preparedResult)) {
    return Result.err(preparedResult.error);
  }
  const target = preparedResult.value.at(0);
  if (target?.kind !== "docx") {
    return panic("DOCX review target was not prepared as DOCX blocks");
  }
  // Each prepared reference is rejoined with the document it came from, so a
  // verified block can be pinned as a passage that outlives this request.
  const references: ReferenceSource[] = [];
  for (const [index, file] of preparedResult.value.slice(1).entries()) {
    const document = selection.value.references[index];
    if (file.kind !== "docx" || document === undefined) {
      return panic("DOCX review reference was not prepared as DOCX blocks");
    }
    references.push({
      workspaceId: document.workspaceId,
      entityId: document.entityId,
      entityVersionId: document.entityVersionId,
      file,
    });
  }

  return Result.ok({
    target,
    references,
    targetEntityVersionId: selection.value.target.entityVersionId,
  });
};
