/**
 * The AI wiring every REST template-fill route hands to the fill service: a
 * usage preflight and a collaborator builder over one lazily-loaded org AI
 * config. The service invokes both only when the manifest declares an AI
 * field, so a deterministic fill neither reads the config nor spends quota.
 * Lives in `lib/templates` (not an endpoint module) so every route — and the
 * lib-level fill logic each route wraps — can depend on it without an
 * endpoint-module-to-endpoint-module import.
 */

import { panic, Result } from "better-result";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import {
  buildAiConditionDecider,
  buildAiFieldGenerator,
  buildAiOccurrenceAdapter,
} from "@/api/lib/docx/ai-field-generator";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createModelActionAdmitter,
  modelActionRefusal,
} from "@/api/lib/rate-limit/model-action-admission";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";

import type { AiFillCollaborators } from "./template-fill-service";

type TemplateFillUsageArgs = {
  /** Org AI (BYOK) config; null when the org has no usable AI config, in which
   *  case the generators are no-ops and no model call (or quota) occurs. */
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
};

/**
 * Usage preflight for the template-fill routes. The fill service runs it only
 * once the manifest is known to declare an AI field, so the static
 * `requiresUsage` config is omitted and this runs in-handler instead. Returns
 * the framework's 402/500 `HandlerError` (the caller returns it as
 * `Result.err`) or `null` to proceed.
 */
const assertTemplateFillUsage = async ({
  orgAIConfig,
  organizationId,
  userId,
  safeDb,
}: TemplateFillUsageArgs): Promise<HandlerError<402 | 500> | null> => {
  // Skip only when no provider could run a model at all. With an instance
  // provider but no org BYOK, the fill still calls the fast model (the
  // instance provider resolves it), so the quota check must apply — a null
  // org config is not "no model call". The metering layer prices the
  // instance-provider call (non-BYOK rate).
  if (!orgAIConfig && !hasTanStackInstanceProvider()) {
    return null;
  }
  return await assertUsageAvailableForHandler({
    metering: { actionType: "chat", modelRole: "fast" },
    organizationId,
    orgAIConfig,
    workspaceId: null,
    userId,
    safeDb,
  });
};

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
  assertUsageAvailable: () => Promise<HandlerError<
    402 | 403 | 429 | 500 | 503
  > | null>;
  aiCollaborators: () => Promise<AiFillCollaborators>;
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
  // The fill draws one action, at the preflight that precedes its first model
  // call; the collaborators built after it carry the proof.
  let admission: ModelDispatchAdmission | undefined;
  const admitModelAction = createModelActionAdmitter({
    organizationId,
    userId,
    organizationStateDb: scopedDb,
    actionKind: "templates.fill",
  });
  const orgAISettings = async () => {
    configPromise ??= scopedDb(
      async (tx) => await loadOrgAISettings(tx, { organizationId, userId }),
    );
    return await configPromise;
  };

  return {
    assertUsageAvailable: async () => {
      const config = await orgAISettings();
      if (Result.isError(config)) {
        return config.error;
      }
      const usageRejection = await assertTemplateFillUsage({
        orgAIConfig: config.value.orgAIConfig,
        organizationId,
        userId,
        safeDb,
      });
      if (usageRejection !== null) {
        return usageRejection;
      }
      const admitted = await admitModelAction(({ admission: granted }) =>
        Promise.resolve(granted),
      );
      if (Result.isError(admitted)) {
        return modelActionRefusal(admitted.error);
      }
      admission = admitted.value;
      return null;
    },
    aiCollaborators: async () => {
      const configResult = await orgAISettings();
      if (Result.isError(configResult)) {
        // The fill service builds collaborators only after this wiring's
        // preflight passed, and the preflight returns this same refusal.
        return panic("template fill AI collaborators built past a refusal");
      }
      const config = configResult.value;
      const shared = {
        admission:
          admission ??
          panic("template fill AI collaborators built before its admission"),
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
  };
};
