import { Result } from "better-result";

import { env } from "@/api/env";
import {
  createSafeRootHandler,
  type HandlerConfig,
} from "@/api/lib/api-handlers";
import {
  CONFIGURED_ACCESS_STATE,
  configuredPaymentRetry,
} from "@/api/lib/usage/configured-access";
import { readOrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";

const config = {
  description:
    "Read the organization's current access notification and its deadline.",
  permissions: { chat: ["create"] },
  access: "read",
  mcp: { type: "internal", reason: "organization_access_ui" },
} satisfies HandlerConfig;

const getAccess = createSafeRootHandler(
  config,
  async function* ({ session, safeDb }) {
    if (!env.FEATURE_CONFIGURED_ACCESS) {
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
