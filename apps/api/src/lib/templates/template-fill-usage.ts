/**
 * Shared AI-usage preflight for every template-fill route (raw upload,
 * by-id download, fill-preview): gated on a model call actually running (an
 * org AI config plus a manifest AI field), so a deterministic fill spends no
 * AI quota. Lives in `lib/templates` (not an endpoint module) so every route
 * — and the lib-level fill logic each route wraps — can depend on it without
 * an endpoint-module-to-endpoint-module import.
 */

import type { SafeDb } from "@/api/db/safe-db";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { assertUsageAvailableForHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasTanStackInstanceProvider } from "@/api/lib/tanstack-ai-models";

type TemplateFillUsageArgs = {
  /** Org AI (BYOK) config; null when the org has no usable AI config, in which
   *  case the generators are no-ops and no model call (or quota) occurs. */
  orgAIConfig: OrgAIConfig | null;
  /** Whether the manifest declares any AI-drafted/adapted field. */
  hasAiFields: boolean;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  safeDb: SafeDb;
};

/**
 * Usage preflight for the template-fill routes, gated on a model call actually
 * running (an org AI config plus a manifest AI field). A deterministic fill
 * spends no AI quota, so the static `requiresUsage` config is omitted and this
 * runs in-handler instead. Returns the framework's 402/500 `HandlerError` (the
 * caller returns it as `Result.err`) or `null` to proceed.
 */
export const assertTemplateFillUsage = async ({
  orgAIConfig,
  hasAiFields,
  organizationId,
  userId,
  safeDb,
}: TemplateFillUsageArgs): Promise<HandlerError<402 | 500> | null> => {
  // Skip only when there is no AI field to bill, or no provider could run a
  // model at all. With an instance provider but no org BYOK, the fill still
  // calls the fast model (the instance provider resolves it), so the quota
  // check must apply — a null org config is not "no model call". The metering
  // layer prices the instance-provider call (non-BYOK rate).
  if (!hasAiFields || (!orgAIConfig && !hasTanStackInstanceProvider())) {
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
