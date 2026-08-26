import { panic, Result } from "better-result";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { proposeReferencePositions } from "@/api/handlers/document-reviews/reference-positions";
import type { ReferenceSource } from "@/api/handlers/document-reviews/reference-positions";
import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import { proposeReviewPositionsBodySchema } from "@/api/handlers/document-reviews/schemas";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { fetchAndPrepareReviewFiles } from "@/api/lib/document-review/prepare-review-files";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { findDuplicatePositionSourceId } from "@/api/lib/workflow/playbook-positions-validation";

const TIMEOUT_MS = 120_000;

const config = {
  description:
    "Propose review positions from one or more reference documents: one reviewable term each, with its kind, its severity, and the reference passages that state the standard for it, plus what was read and deliberately not compared.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  body: proposeReviewPositionsBodySchema,
} satisfies HandlerConfig;

const proposePositions = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body,
    session,
    orgAIConfig,
    orgAIConfigStatus,
    promptCachingEnabled,
    user,
  }) {
    const organizationId = session.activeOrganizationId;
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
    // Same cross-matter rule as run creation: the membership-scoped read
    // returns only matters the caller can see, and the selection holds each
    // row to the matter its reference named.
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
      userId: user.id,
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

    const serviceTier = "standard" as const;
    const proposal = await proposeReferencePositions({
      target,
      references,
      seededPositions: body.seededPositions,
      positionsMax: DOCUMENT_REVIEW_LIMITS.positionsMax,
      targetEntityVersionId: selection.value.target.entityVersionId,
      organizationId,
      workspaceId,
      orgAIConfig,
      promptCachingEnabled,
      serviceTier,
      usageMetering: {
        actionType: "chat",
        organizationId,
        safeDb,
        serviceTier,
        userId: user.id,
        workspaceId,
      },
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (Result.isError(proposal)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Internal server error",
          cause: proposal.error,
        }),
      );
    }
    return Result.ok(proposal.value);
  },
);

export default proposePositions;
