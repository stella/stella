import { panic, Result } from "better-result";

import { compareReferenceDocuments } from "@/api/handlers/document-reviews/reference-compare";
import { buildReferenceReviewAuditEvent } from "@/api/handlers/document-reviews/reference-review-audit";
import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import { validateReviewTopics } from "@/api/handlers/document-reviews/review-topics";
import { compareReferencesBodySchema } from "@/api/handlers/document-reviews/schemas";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";
import { fetchAndPrepareFiles } from "@/api/lib/workflow/generate-batch";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";

const DOCUMENT_REVIEW_TIMEOUT_MS = 120_000;

const config = {
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  body: compareReferencesBodySchema,
} satisfies HandlerConfig;

const compareReferences = createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    body,
    session,
    orgAIConfig,
    promptCachingEnabled,
    recordAuditEvent,
    user,
  }) {
    const organizationId = session.activeOrganizationId;
    const validTopics = validateReviewTopics(body.topics, "comparison");
    if (Result.isError(validTopics)) {
      return Result.err(validTopics.error);
    }

    yield* requireTanStackAIAvailableForRole({
      orgConfig: orgAIConfig,
      role: "pdf",
    });

    const entityIds = [
      body.target.entityId,
      ...body.references.map((reference) => reference.entityId),
    ];
    const loadedEntities = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: {
            id: { in: [...new Set(entityIds)] },
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true },
          limit: body.references.length + 1,
          with: {
            currentVersion: {
              columns: { id: true },
              with: {
                fields: {
                  columns: { id: true, content: true },
                },
              },
            },
          },
        }),
      ),
    );

    const selection = resolveReviewSelection({
      target: body.target,
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
      selection.value.target.file,
      ...selection.value.references.map((reference) => reference.file),
    ];
    const preparedResult = await Result.tryPromise({
      try: async () =>
        await fetchAndPrepareFiles(resolvedFiles, organizationId, workspaceId),
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

    const targetPrepared = preparedResult.value.at(0);
    if (targetPrepared?.kind !== "docx") {
      return panic("DOCX review target was not prepared as DOCX blocks");
    }
    const referencePrepared: PreparedDocxFile[] = [];
    for (const file of preparedResult.value.slice(1)) {
      if (file.kind !== "docx") {
        return panic("DOCX review reference was not prepared as DOCX blocks");
      }
      referencePrepared.push(file);
    }

    const serviceTier = "standard" as const;
    const usageMetering = {
      actionType: "chat" as const,
      organizationId,
      safeDb,
      serviceTier,
      userId: user.id,
      workspaceId,
    };
    const comparison = await compareReferenceDocuments({
      target: targetPrepared,
      references: referencePrepared,
      topics: body.topics,
      targetEntityVersionId: selection.value.target.entityVersionId,
      referenceEntityVersionIds: selection.value.references.map(
        (reference) => reference.entityVersionId,
      ),
      organizationId,
      workspaceId,
      orgAIConfig,
      promptCachingEnabled,
      serviceTier,
      usageMetering,
      abortSignal: AbortSignal.timeout(DOCUMENT_REVIEW_TIMEOUT_MS),
    });
    if (Result.isError(comparison)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Internal server error",
          cause: comparison.error,
        }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(
          tx,
          buildReferenceReviewAuditEvent({
            target: selection.value.target,
            references: selection.value.references,
            findingCount: comparison.value.length,
          }),
        );
        return undefined;
      }),
    );

    return Result.ok({ findings: comparison.value });
  },
);

export default compareReferences;
