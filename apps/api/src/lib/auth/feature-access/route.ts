import Elysia, { InternalServerError, NotFoundError } from "elysia";

import { resolveRequestAuth } from "@/api/lib/auth";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import type { FeatureId } from "@/api/lib/feature-access/registry";

type FeatureAccessGateDependencies = {
  resolveAuth?: typeof resolveRequestAuth;
};

/** Hide unavailable features before schema validation can reveal the route. */
export const featureAccessGate = (
  featureId: FeatureId,
  { resolveAuth = resolveRequestAuth }: FeatureAccessGateDependencies = {},
) =>
  new Elysia().onTransform({ as: "scoped" }, async (context) => {
    const authorization = await resolveAuth(context);
    if (!authorization.ok) {
      if (authorization.statusCode === 500) {
        throw new InternalServerError();
      }
      throw new NotFoundError();
    }
    const { featureAccessSnapshot, session, user } = authorization.value;
    const principal = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    // The request's member lookup already decided feature access; reading it
    // here costs no query.
    if (!isFeatureEnabled(featureAccessSnapshot, featureId, principal)) {
      throw new NotFoundError();
    }
    Object.assign(context, { featureAccessSnapshot });
  });
