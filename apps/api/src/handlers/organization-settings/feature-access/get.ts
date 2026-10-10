import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";

const config = {
  description: "Report the features available to the signed-in member.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const snapshot = yield* Result.await(
      loadFeatureAccessSnapshot({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
      }),
    );
    return Result.ok({
      organizationId: snapshot.organizationId,
      userId: snapshot.userId,
      enabledFeatures: [...snapshot.decisions].flatMap(([id, decision]) =>
        decision.status === "enabled" ? [id] : [],
      ),
    });
  },
);
