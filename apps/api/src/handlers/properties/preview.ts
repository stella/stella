import { Value } from "@sinclair/typebox/value";
import { matchError, Result } from "better-result";
import { t } from "elysia";

import { propertyContentSchema } from "@/api/db/schema-validators";
import {
  loadOrgAIConfig,
  loadPromptCachingPreference,
} from "@/api/lib/ai-config-loader";
import { aiHandlerError } from "@/api/lib/ai-error";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { serializeAITool } from "@/api/lib/markdown/ai-tool";
import { getBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";
import type { AIResult } from "@/api/lib/workflow/generate-batch-shared";
import type {
  BatchProperty,
  PropertyBatch,
} from "@/api/lib/workflow/get-execution-plan";

const previewableContentType = t.Union([
  t.Literal("text"),
  t.Literal("single-select"),
  t.Literal("multi-select"),
  t.Literal("date"),
  t.Literal("int"),
]);

const optionSchema = t.Object({
  color: t.String({ minLength: 1, maxLength: 64 }),
  value: t.String({ minLength: 1, maxLength: 1000 }),
});

const dependencySchema = t.Object({
  dependsOnPropertyId: tSafeId("property"),
});

const previewBodySchema = t.Object({
  prompt: t.String({ minLength: 1, maxLength: 1000 }),
  contentType: previewableContentType,
  entityId: tSafeId("entity"),
  options: t.Optional(t.Array(optionSchema)),
  dependencies: t.Optional(t.Array(dependencySchema)),
});

const config = {
  permissions: { property: ["create"] },
  body: previewBodySchema,
} satisfies HandlerConfig;

const PREVIEW_TIMEOUT_MS = 60_000;

type PreviewResponse =
  | { status: "ready"; content: AIResult["content"] }
  | { status: "unsupported" }
  | { status: "skipped" }
  | { status: "empty" };

const previewProperty = createSafeHandler(
  config,
  async function* ({ safeDb, scopedDb, session, workspaceId, request, body }) {
    const entity = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findFirst({
          where: {
            id: { eq: body.entityId },
            workspaceId: { eq: workspaceId },
          },
          columns: { currentVersionId: true },
        }),
      ),
    );

    if (!entity || entity.currentVersionId === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Entity not found" }),
      );
    }

    // Mirror the create handler: defence-in-depth validation that
    // every dependency property belongs to the current workspace.
    // scopedDb already scopes queries, but verifying explicitly keeps
    // the contract consistent across endpoints.
    const dependencyIds = [
      ...new Set((body.dependencies ?? []).map((d) => d.dependsOnPropertyId)),
    ];
    if (dependencyIds.length > 0) {
      const dependencyRows = yield* Result.await(
        safeDb((tx) =>
          tx.query.properties.findMany({
            where: {
              id: { in: dependencyIds },
              workspaceId: { eq: workspaceId },
            },
            columns: { id: true },
          }),
        ),
      );
      if (dependencyRows.length !== dependencyIds.length) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "Dependency property not found",
          }),
        );
      }
    }

    if (
      body.contentType === "single-select" ||
      body.contentType === "multi-select"
    ) {
      const optionsValid = Value.Check(propertyContentSchema, {
        version: 1,
        type: body.contentType,
        options: body.options ?? [],
        fallback: null,
      });
      if (!optionsValid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Invalid select options",
          }),
        );
      }
    }

    const propertyId = createSafeId<"property">();

    const batchProperty = ((): BatchProperty => {
      const dependencies = (body.dependencies ?? []).map((d) => ({
        dependsOnPropertyId: d.dependsOnPropertyId,
        condition: null,
      }));
      // Mirror the create/update path which converts mention HTML
      // to markdown before persistence so preview output reflects
      // what the saved property will run with.
      const serialized = serializeAITool({
        version: 1,
        type: "ai-model",
        prompt: body.prompt,
        dependencies,
      });
      const tool = {
        version: 1 as const,
        type: "ai-model" as const,
        prompt: serialized.prompt,
      };
      const base = { id: propertyId, status: "stale" as const, tool };

      if (
        body.contentType === "single-select" ||
        body.contentType === "multi-select"
      ) {
        return {
          ...base,
          content: {
            version: 1,
            type: body.contentType,
            options: body.options ?? [],
            fallback: null,
          },
          dependencies,
        };
      }

      return {
        ...base,
        content: { version: 1, type: body.contentType },
        dependencies,
      };
    })();

    const inputPropertyIds = dependencyIds;

    const batch: PropertyBatch = {
      id: "preview",
      inputs: inputPropertyIds,
      properties: [batchProperty],
    };

    const [orgAIConfig, promptCachingEnabled] = await Promise.all([
      loadOrgAIConfig(session.activeOrganizationId),
      loadPromptCachingPreference(session.activeOrganizationId),
    ]);
    const generateFn = getBatchGenerator();

    const generateResult = await generateFn({
      abortSignal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      ]),
      batch,
      entityVersionId: entity.currentVersionId,
      organizationId: session.activeOrganizationId,
      workspaceId,
      scopedDb,
      orgAIConfig,
      promptCachingEnabled,
    });

    if (Result.isError(generateResult)) {
      // WorkflowValidationError: dependency fields are empty/unsupported
      // on this entity. That's a real "skipped" outcome the UI handles
      // gracefully; reserve 502 for actual integration failures.
      const skipped: boolean = matchError(generateResult.error, {
        WorkflowValidationError: () => true,
        WorkflowIntegrationError: () => false,
      });
      if (skipped) {
        return Result.ok({ status: "skipped" } satisfies PreviewResponse);
      }
      // WorkflowIntegrationError carries the underlying AI provider
      // failure (if any) on its `cause` — classify against that so
      // quota/usage-limit errors propagate the right status to the UI.
      return Result.err(
        aiHandlerError(generateResult.error.cause, {
          status: 502,
          message: "Preview generation failed",
        }),
      );
    }

    const batchResult = generateResult.value;

    let response: PreviewResponse;
    if (batchResult.unsupportedPropertyIds.length > 0) {
      response = { status: "unsupported" };
    } else if (batchResult.skippedPropertyIds.length > 0) {
      response = { status: "skipped" };
    } else {
      const aiResult = batchResult.aiResults.at(0);
      response = aiResult
        ? { status: "ready", content: aiResult.content }
        : { status: "empty" };
    }

    return Result.ok(response);
  },
);

export default previewProperty;
