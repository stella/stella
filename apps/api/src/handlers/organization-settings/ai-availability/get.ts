import { Result } from "better-result";

import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  hasTanStackInstanceProvider,
  isDeferredServiceTierAvailableForRole,
  mockAnswersForOrganization,
} from "@/api/lib/tanstack-ai-models";

const config = {
  description:
    "Report whether AI is usable in this organization: whether the " +
    "deployment provides a model, whether the organization has configured " +
    "its own provider, whether either of those makes AI available at all, " +
    "whether the reduced-cost deferred service tier can be used, and " +
    "whether a local development stack answers with canned replies " +
    "instead of a model. " +
    "Booleans only, so any member may read it.",
  // Any org member needs to know whether AI is usable; the answer
  // is just two booleans, so it does not require admin scope.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "anonymization_admin",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

const readAIAvailability = createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* ({ orgAIConfig, orgAIConfigStatus }) {
    const instanceProvisioned = hasTanStackInstanceProvider();
    const orgConfigured = orgAIConfig !== null;
    return Result.ok({
      instanceProvisioned,
      orgConfigured,
      // The same status every AI call site refuses on: an org barred from the
      // instance provider, a member without a seat, or an unreadable stored
      // config gets no model, so the client must ask instead of offering one.
      available:
        orgAIConfigStatus === ORG_AI_CONFIG_STATUS.ok &&
        (instanceProvisioned || orgConfigured),
      deferredServiceTierAvailable: isDeferredServiceTierAvailableForRole(
        "pdf",
        orgAIConfig,
      ),
      // Always false outside local development and tests: deployed runtimes
      // refuse USE_MOCK_AI at boot.
      mockAnswers: mockAnswersForOrganization(orgAIConfig),
    });
  },
);

export default readAIAvailability;
