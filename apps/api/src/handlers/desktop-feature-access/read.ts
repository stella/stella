import { panic, Result } from "better-result";
import * as v from "valibot";

import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";

const decisionSchema = v.strictObject({
  status: v.picklist(["enabled", "hidden"]),
});

const config = {
  contract: "patch",
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    v.object({
      features: v.object({
        "activity-timeline": decisionSchema,
        "time-billing": decisionSchema,
        "local-agents": decisionSchema,
      } satisfies Record<DesktopFeatureId, typeof decisionSchema>),
    }),
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
    const { featureAccessSnapshot: snapshot } = yield* Result.await(
      authorizeAccount(request),
    );
    return Result.ok({
      features: {
        "activity-timeline": decide(snapshot, "activity-timeline"),
        "time-billing": decide(snapshot, "time-billing"),
        "local-agents": decide(snapshot, "local-agents"),
      } satisfies Record<DesktopFeatureId, unknown>,
    });
  });
};

export default createDesktopFeatureAccessReadEndpoint();
