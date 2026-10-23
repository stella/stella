import { panic, Result } from "better-result";

import { updateAIConfigConfig } from "@/api/handlers/organization-settings/update-ai-config";
import {
  ORG_AI_CONFIG_STATUS,
  type OrgAIConfigStatus,
} from "@/api/lib/ai-config-loader-core";
import {
  ACCOUNT_ACCESS,
  checkHandlerConfigurationAdmission,
  createSafeRootHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  hasTanStackInstanceProvider,
  isDeferredServiceTierAvailableForTask,
  mockAnswersForOrganization,
} from "@/api/lib/tanstack-ai-models";

const config = {
  contract: "patch",
  description:
    "Report whether AI is usable in this organization: whether the " +
    "deployment provides a model, whether the organization has configured " +
    "its own provider, whether either of those makes AI available at all, " +
    "whether the reduced-cost deferred service tier can be used, and " +
    "whether a local development stack answers with canned replies " +
    "instead of a model, why AI is unavailable, and whether this principal " +
    "may configure the organization's provider. Any member may read it.",
  // Any org member needs to know whether AI is usable and whether they
  // may configure it; the answer carries no secret, so it needs no admin scope.
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

type UnavailableReasonOptions = {
  available: boolean;
  instanceProvisioned: boolean;
  orgConfigured: boolean;
  orgAIConfigStatus: OrgAIConfigStatus;
};

const resolveUnavailableReason = ({
  available,
  instanceProvisioned,
  orgConfigured,
  orgAIConfigStatus,
}: UnavailableReasonOptions) => {
  if (available) {
    return null;
  }
  switch (orgAIConfigStatus) {
    case ORG_AI_CONFIG_STATUS.ok:
      if (!instanceProvisioned && !orgConfigured) {
        return "provider_not_configured" as const;
      }
      return panic("Unavailable AI has no unavailable reason");
    case ORG_AI_CONFIG_STATUS.ownKeyRequired:
      return ORG_AI_CONFIG_STATUS.ownKeyRequired;
    case ORG_AI_CONFIG_STATUS.memberAssignmentRequired:
      return ORG_AI_CONFIG_STATUS.memberAssignmentRequired;
    case ORG_AI_CONFIG_STATUS.unreadable:
      return ORG_AI_CONFIG_STATUS.unreadable;
    default:
      orgAIConfigStatus satisfies never;
      return panic(`Unhandled AI config status: ${String(orgAIConfigStatus)}`);
  }
};

const readAIAvailability = createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* ({ orgAIConfig, orgAIConfigStatus, memberRole, user }) {
    const instanceProvisioned = hasTanStackInstanceProvider();
    const orgConfigured = orgAIConfig !== null;
    const available =
      orgAIConfigStatus === ORG_AI_CONFIG_STATUS.ok &&
      (instanceProvisioned || orgConfigured);
    return Result.ok({
      instanceProvisioned,
      orgConfigured,
      // The same status every AI call site refuses on: an org barred from the
      // instance provider, a member without a seat, or an unreadable stored
      // config gets no model, so the client must ask instead of offering one.
      available,
      unavailableReason: resolveUnavailableReason({
        available,
        instanceProvisioned,
        orgConfigured,
        orgAIConfigStatus,
      }),
      providerConfiguration: checkHandlerConfigurationAdmission({
        principal: { memberRole, readEmail: () => user.email },
        config: updateAIConfigConfig,
      }),
      deferredServiceTierAvailable: isDeferredServiceTierAvailableForTask(
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
