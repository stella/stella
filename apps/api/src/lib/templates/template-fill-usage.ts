/**
 * The AI wiring every REST template-fill route hands to the fill service: a
 * usage preflight and a collaborator builder over one lazily-loaded org AI
 * config. The service invokes both only when the manifest declares an AI
 * field, so a deterministic fill neither reads the config nor spends quota.
 * Lives in `lib/templates` (not an endpoint module) so every route — and the
 * lib-level fill logic each route wraps — can depend on it without an
 * endpoint-module-to-endpoint-module import.
 */

import { Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { authorizeHandlerUsage } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";

import type { AiFillCollaboratorProvider } from "./template-fill-service";

type TemplateFillAiWiringArgs = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  /** Analytics feature label: the download/upload fill routes bill as
   *  `templates.fill`, the live preview as `templates.fill_preview`. */
  feature: "templates.fill" | "templates.fill_preview";
  /** The template's declared languages, so the aiAdapt rewriter conjugates in
   *  them. Absent for a raw upload, which has no stored template row. */
  documentLanguages?: readonly string[] | undefined;
};

type TemplateFillAiWiring = {
  aiCollaborators: AiFillCollaboratorProvider<HandlerError<402 | 403 | 500>>;
};

/**
 * Build the two AI hooks the fill service takes. Both share a single org AI
 * config read, resolved on first use: the service calls the preflight before
 * any model call and the collaborator builder just after, and calls neither
 * when the template declares no AI field.
 *
 * The routes are root-scoped (a raw upload, or a template chosen by id with no
 * matter binding), so there is no workspace scope to redact tenant ids
 * against.
 */
export const buildTemplateFillAiWiring = ({
  organizationId,
  userId,
  safeDb,
  scopedDb,
  feature,
  documentLanguages,
}: TemplateFillAiWiringArgs): TemplateFillAiWiring => {
  let configPromise: ReturnType<typeof loadOrgAISettings> | undefined;
  const orgAISettings = async () => {
    configPromise ??= scopedDb(
      async (tx) => await loadOrgAISettings(tx, { organizationId, userId }),
    );
    return await configPromise;
  };

  return {
    aiCollaborators: async () => {
      const configResult = await orgAISettings();
      if (Result.isError(configResult)) {
        return Result.err(configResult.error);
      }
      const config = configResult.value;
      return await authorizeHandlerUsage({
        metering:
          config.orgAIConfig || hasTanStackInstanceProvider()
            ? { actionType: "chat", modelRole: "fast" }
            : null,
        organizationId,
        userId,
        orgAIConfig: config.orgAIConfig,
        workspaceId: null,
        safeDb,
        buildCollaborators: () => {
          const shared = {
            orgAIConfig: config.orgAIConfig,
            managedAIResidency: config.managedAIResidency,
            organizationId,
            skillContext: { organizationId, safeDb, userId },
            aiAnalytics: createTanStackAIAnalyticsCallbacks({
              dataClass: "customer",
              usageMetering: {
                actionType: "chat",
                organizationId,
                safeDb,
                serviceTier: "standard",
                userId,
                workspaceId: null,
              },
              feature,
              modelRole: "fast",
              orgAIConfig: config.orgAIConfig,
              properties: { organization_id: organizationId },
              traceId: Bun.randomUUIDv7(),
            }),
            tenantWorkspaceIds: [],
          };
          return {
            generateAiValue: buildAiFieldGenerator(shared),
            decideAiCondition: buildAiConditionDecider(shared),
            adaptAiValue: buildAiOccurrenceAdapter(
              documentLanguages === undefined
                ? shared
                : { ...shared, documentLanguages },
            ),
          };
        },
      });
    },
  };
};
