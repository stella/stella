import { Result } from "better-result";

import {
  ACCOUNT_ACCESS,
  createSafeRootHandler,
  type HandlerConfig,
  type SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  CONFIGURED_ACCESS_STATE,
  configuredPaymentRetry,
} from "@/api/lib/usage/configured-access";
import { readOrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";

const config = {
  description:
    "Read the organization's current access notification and its deadline.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "hosted_billing" },
} satisfies HandlerConfig;

type UsageAccessResult = {
  paymentRetry: ReturnType<typeof configuredPaymentRetry>;
};

const getAccess = createSafeRootHandler(
  config,
  async function* ({
    session,
    safeDb,
  }): SafeHandlerGenerator<UsageAccessResult> {
    if (!isDeploymentFeatureEnabled("FEATURE_CONFIGURED_ACCESS")) {
      return Result.ok({ paymentRetry: { status: "none" as const } });
    }
    const state = yield* Result.await(
      safeDb(
        async (tx) =>
          await readOrganizationAccessSnapshot(
            tx,
            session.activeOrganizationId,
          ),
      ),
    );
    return Result.ok({
      paymentRetry: configuredPaymentRetry(
        state?.state === CONFIGURED_ACCESS_STATE
          ? state.configuredAccess
          : null,
        new Date(),
      ),
    });
  },
);

export default getAccess;
