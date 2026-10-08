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
  type AdmittedModelAction,
  type ModelActionAdmitter,
} from "@/api/lib/rate-limit/model-action-admission";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";

import type {
  AiFillAdmission,
  AiFillCollaborators,
} from "./template-fill-service";

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

type RunAdmittedAiFillOptions<TRejection, T> = {
  admitModelAction: ModelActionAdmitter;
  /** Runs before admission draws an action; a rejection refuses the fill. */
  preflight: () => Promise<TRejection | null>;
  /** Builds the collaborators on the admitted action's proof and signal. */
  collaborators: (
    admitted: AdmittedModelAction,
  ) => AiFillCollaborators | Promise<AiFillCollaborators>;
  fill: (collaborators: AiFillCollaborators) => Promise<T>;
};

/**
 * The {@link AiFillAdmission} every admitting fill caller runs: the usage
 * preflight, then the whole fill inside one admitted action, so the action is
 * held until the fill's last model call settles. A failure inside the fill
 * propagates as the fill's own; only a failure to admit is a refusal.
 */
export const runAdmittedAiFill = async <TRejection, T>({
  admitModelAction,
  preflight,
  collaborators,
  fill,
}: RunAdmittedAiFillOptions<TRejection, T>): Promise<
  | { type: "refused"; rejection: TRejection | HandlerError<403 | 429 | 503> }
  | { type: "admitted"; value: T }
> => {
  const rejection = await preflight();
  if (rejection !== null) {
    return { type: "refused", rejection };
  }
  const filling: { promise: Promise<T> | null } = { promise: null };
  const admitted = await admitModelAction(async (action) => {
    filling.promise = (async () => await fill(await collaborators(action)))();
    return await filling.promise;
  });
  if (Result.isOk(admitted)) {
    return { type: "admitted", value: admitted.value };
  }
  if (filling.promise !== null) {
    // Awaiting the fill again rejects with its own failure; a fill that
    // settled keeps its value, as a settled admitted action does.
    return { type: "admitted", value: await filling.promise };
  }
  return { type: "refused", rejection: modelActionRefusal(admitted.error) };
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
  /** Admission seam; ordinary callers draw a `templates.fill` action. */
  admitModelAction?: ModelActionAdmitter | undefined;
};

type TemplateFillAiWiring = {
  aiFill: AiFillAdmission<HandlerError<402 | 403 | 429 | 500 | 503>>;
};

/**
 * Build the AI admission the fill service takes: the usage preflight, then the
 * fill's model work inside one admitted `templates.fill` action, held until
 * that work settles. The service calls it only when the template declares an
 * AI field.
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
  admitModelAction = createModelActionAdmitter({
    organizationId,
    userId,
    organizationStateDb: scopedDb,
    actionKind: "templates.fill",
  }),
}: TemplateFillAiWiringArgs): TemplateFillAiWiring => {
  let configPromise: ReturnType<typeof loadOrgAISettings> | undefined;
  const orgAISettings = async () => {
    configPromise ??= scopedDb(
      async (tx) => await loadOrgAISettings(tx, { organizationId, userId }),
    );
    return await configPromise;
  };
  const settings = async () => {
    const config = await orgAISettings();
    // The preflight read the same config and refused on its failure.
    return Result.isError(config)
      ? panic("template fill AI collaborators built past a refusal")
      : config.value;
  };
  return {
    aiFill: async (fill) =>
      await runAdmittedAiFill({
        admitModelAction,
        preflight: async () => {
          const config = await orgAISettings();
          if (Result.isError(config)) {
            return config.error;
          }
          return await assertTemplateFillUsage({
            orgAIConfig: config.value.orgAIConfig,
            organizationId,
            userId,
            safeDb,
          });
        },
        collaborators: async ({ signal, admission }) => {
          const config = await settings();
          const shared = {
            admission,
            operationSignal: signal,
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
        fill,
      }),
  };
};
