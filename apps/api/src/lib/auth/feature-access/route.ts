import { Result } from "better-result";
import Elysia, { InternalServerError, NotFoundError } from "elysia";

import { resolveRequestAuth } from "@/api/lib/auth";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { isFeatureEnabled } from "@/api/lib/auth/feature-access/policy";
import type { FeatureId } from "@/api/lib/feature-access/registry";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const SNAPSHOT_FAILURE_SINK = failureSink({
  event: "feature_access.snapshot.failed",
  expected: [],
});

type FeatureAccessGateDependencies = {
  resolveAuth?: typeof resolveRequestAuth;
  loadSnapshot?: typeof loadFeatureAccessSnapshot;
};

/** Hide unavailable features before schema validation can reveal the route. */
export const featureAccessGate = (
  featureId: FeatureId,
  {
    resolveAuth = resolveRequestAuth,
    loadSnapshot = loadFeatureAccessSnapshot,
  }: FeatureAccessGateDependencies = {},
) =>
  new Elysia().onTransform({ as: "scoped" }, async (context) => {
    const authorization = await resolveAuth(context);
    if (!authorization.ok) {
      if (authorization.statusCode === 500) {
        throw new InternalServerError();
      }
      throw new NotFoundError();
    }
    const { safeDb, session, user } = authorization.value;
    const principal = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const snapshot = await loadSnapshot({ safeDb, ...principal });
    if (Result.isError(snapshot)) {
      observeFailure(snapshot.error, {
        sink: SNAPSHOT_FAILURE_SINK,
        request: context.request,
        ctx: { feature: featureId },
      });
      throw snapshot.error;
    }
    if (!isFeatureEnabled(snapshot.value, featureId, principal)) {
      throw new NotFoundError();
    }
    Object.assign(context, { featureAccessSnapshot: snapshot.value });
  });
