/**
 * The review launcher's first screen: which side the reviewer acts for, read
 * from the target document alone, before any reference is chosen and before
 * any proposal pass runs.
 *
 * The answer is deterministic for a document version's content, so it is
 * cached per `entityVersionId` (see `document_review_parties`): the first
 * call for a version detects it, every later call for the same version
 * reads the cached row without a model call.
 */

import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { documentReviewParties } from "@/api/db/schema";
import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import { documentReviewTargetSchema } from "@/api/handlers/document-reviews/schemas";
import {
  assertUsageAvailableForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import {
  detectReviewParties,
  REVIEW_PARTIES_PROMPT_VERSION,
} from "@/api/lib/document-review/parties";
import { fetchAndPrepareReviewFiles } from "@/api/lib/document-review/prepare-review-files";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireTanStackAIAvailableForRole } from "@/api/lib/tanstack-ai-models";

const TIMEOUT_MS = 60_000;

const documentReviewPartiesBodySchema = t.Object({
  target: documentReviewTargetSchema,
});

const config = {
  description:
    "Detect a target document's parties ahead of any position proposal, so the review launcher can show which side the reviewer acts for before choosing references.",
  permissions: { workspace: ["read"] },
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  body: documentReviewPartiesBodySchema,
} satisfies HandlerConfig;

const reviewParties = createSafeHandler(
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
    const targetRef = { ...body.target, workspaceId };

    const loadedEntities = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: { id: { in: [targetRef.entityId] } },
          columns: { id: true, workspaceId: true },
          limit: 1,
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
      references: [],
      entities: loadedEntities,
    });
    if (Result.isError(selection)) {
      return Result.err(selection.error);
    }
    const { entityId, entityVersionId, file } = selection.value.target;

    const cached = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ parties: documentReviewParties.parties })
          .from(documentReviewParties)
          .where(
            and(
              eq(documentReviewParties.workspaceId, workspaceId),
              eq(documentReviewParties.entityVersionId, entityVersionId),
              eq(
                documentReviewParties.promptVersion,
                REVIEW_PARTIES_PROMPT_VERSION,
              ),
            ),
          )
          .limit(1),
      ),
    );
    const cachedRow = cached.at(0);
    if (cachedRow !== undefined) {
      return Result.ok({ entityVersionId, parties: cachedRow.parties });
    }

    yield* requireTanStackAIAvailableForRole({
      orgConfig: orgAIConfig,
      role: "pdf",
    });

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

    const preparedResult = await Result.tryPromise({
      try: async () => await fetchAndPrepareReviewFiles([file], organizationId),
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

    const serviceTier = "standard" as const;
    const detected = await detectReviewParties({
      target,
      targetEntityVersionId: entityVersionId,
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
    if (Result.isError(detected)) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Internal server error",
          cause: detected.error,
        }),
      );
    }
    const parties = detected.value;

    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — derived AI cache keyed by entity version;
        // recomputable from the document's current content, never surfaces
        // as an audited mutation on its own.
        await tx
          .insert(documentReviewParties)
          .values({
            id: createSafeId<"documentReviewParty">(),
            organizationId,
            workspaceId,
            entityId,
            entityVersionId,
            promptVersion: REVIEW_PARTIES_PROMPT_VERSION,
            parties,
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: documentReviewParties.entityVersionId,
            set: {
              promptVersion: sql`excluded.prompt_version`,
              parties: sql`excluded.parties`,
              createdAt: sql`excluded.created_at`,
            },
          });
      }),
    );

    return Result.ok({ entityVersionId, parties });
  },
);

export default reviewParties;
