import { Result } from "better-result";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { prepareReferenceProposal } from "@/api/handlers/document-reviews/prepare-proposal";
import { proposeReferencePositions } from "@/api/handlers/document-reviews/reference-positions";
import { proposeReviewPositionsBodySchema } from "@/api/handlers/document-reviews/schemas";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const TIMEOUT_MS = 120_000;

const config = {
  description:
    "Propose review positions from one or more reference documents: one reviewable term each, with its kind, its severity, what the term is for and what to compare, and the reference passages that state the standard for it, plus what was read and deliberately not compared.",
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
    promptCachingEnabled,
    user,
  }) {
    const organizationId = session.activeOrganizationId;
    const prepared = yield* yield* prepareReferenceProposal({
      body,
      orgAIConfig,
      organizationId,
      safeDb,
      userId: user.id,
      workspaceId,
    });

    const serviceTier = "standard" as const;
    const proposal = await proposeReferencePositions({
      target: prepared.target,
      references: prepared.references,
      seededPositions: body.seededPositions,
      perspective: body.perspective,
      positionsMax: DOCUMENT_REVIEW_LIMITS.positionsMax,
      targetEntityVersionId: prepared.targetEntityVersionId,
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
