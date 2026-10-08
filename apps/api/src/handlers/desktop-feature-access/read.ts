import { panic, Result } from "better-result";
import { t } from "elysia";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { FeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";

const decisionSchema = t.Object(
  { status: t.UnionEnum(["enabled", "hidden"]) },
  { additionalProperties: false },
);

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    t.Object(
      {
        features: t.Object(
          {
            "activity-timeline": decisionSchema,
            "time-billing": decisionSchema,
          } satisfies Record<DesktopFeatureId, typeof decisionSchema>,
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  ),
} satisfies PublicHandlerConfig;

// The registry check binds every desktop feature id to a registered feature,
// and a snapshot decides every registered feature.
const decide = (
  snapshot: FeatureAccessSnapshot,
  featureId: DesktopFeatureId,
) => ({
  status: (
    snapshot.decisions.get(featureId) ??
    panic("Desktop feature access requires a decided feature")
  ).status,
});

type DesktopFeatureAccessReadDependencies = {
  authorizeAccount: typeof authorizeDesktopAccount;
};

export const createDesktopFeatureAccessReadEndpoint = (
  dependencies?: DesktopFeatureAccessReadDependencies,
) => {
  const authorizeAccount =
    dependencies?.authorizeAccount ?? authorizeDesktopAccount;
  return createSafeBoundedPublicHandler(config, async function* ({ request }) {
    const { scopedDb, userId, organizationId } = yield* Result.await(
      authorizeAccount(request),
    );
    const snapshot = yield* Result.await(
      loadFeatureAccessSnapshot({
        safeDb: safeDbFromScoped(scopedDb),
        organizationId,
        userId,
      }),
    );
    return Result.ok({
      features: {
        "activity-timeline": decide(snapshot, "activity-timeline"),
        "time-billing": decide(snapshot, "time-billing"),
      } satisfies Record<DesktopFeatureId, unknown>,
    });
  });
};

export default createDesktopFeatureAccessReadEndpoint();
