import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";

const config = {
  description:
    "Report which features this caller may access, so the web client offers only those.",
  // Any org member may read their own feature decisions.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
} satisfies HandlerConfig;

/** The features the web may show to this caller in this organization. */
export const readDeploymentFeatures = (snapshot: FeatureAccessSnapshot) => ({
  timeBilling: isFeatureEnabled(snapshot, "time-billing", snapshot),
});

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const snapshot = yield* Result.await(
      safeDb(
        async (tx) =>
          await resolveFeatureAccessSnapshot({
            tx,
            organizationId: session.activeOrganizationId,
            userId: user.id,
          }),
      ),
    );
    return Result.ok(readDeploymentFeatures(snapshot));
  },
);
