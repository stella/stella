import type { ResponseHeaders } from "@/api/http/context";
import { HTTP_FAILURE, HttpFailureError } from "@/api/http/errors";
import { toResponse } from "@/api/http/respond";
import type { Middleware } from "@/api/http/route";
import { status } from "@/api/http/status";
import { AUTH_REJECTION_BODY, resolveRequestAuth } from "@/api/lib/auth";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import type { FeatureId } from "@/api/lib/feature-access/registry";

type FeatureAccessGateDependencies = {
  resolveAuth?: typeof resolveRequestAuth;
};

const gatedFeatures = new WeakMap<Middleware, FeatureId>();

/** Whether the request's refusal set an RFC 6750 bearer challenge. */
const bearerChallenge = (headers: ResponseHeaders): boolean => {
  const challenge = headers["www-authenticate"];
  return typeof challenge === "string" && challenge.startsWith("Bearer ");
};

/** The feature a route gate stands for, or `undefined` for any other middleware. */
export const featureAccessGateFeature = (
  middleware: Middleware,
): FeatureId | undefined => gatedFeatures.get(middleware);

/**
 * Hide a feature the caller cannot use: its routes answer exactly like an
 * absent route, before their input is read. The request's member lookup
 * already decided feature access, and the route's own access step reuses the
 * same memoized lookup, so this costs no query.
 */
export const featureAccessGate = (
  featureId: FeatureId,
  { resolveAuth = resolveRequestAuth }: FeatureAccessGateDependencies = {},
): Middleware => {
  const gate: Middleware = async (ctx, inner) => {
    const authorization = await resolveAuth(ctx);
    if (!authorization.ok) {
      if (authorization.statusCode === 500) {
        return toResponse(status(500, AUTH_REJECTION_BODY[500]), ctx.set);
      }
      // An access token the resolver challenged (expired, or without this
      // route's scope) hears the challenge, so its client can refresh or ask
      // for the scope again; it already proved it is a client of this
      // server. Every other refusal still answers like an absent route.
      if (
        (authorization.statusCode === 401 ||
          authorization.statusCode === 403) &&
        bearerChallenge(ctx.set.headers)
      ) {
        return toResponse(
          status(
            authorization.statusCode,
            AUTH_REJECTION_BODY[authorization.statusCode],
          ),
          ctx.set,
        );
      }
      throw new HttpFailureError(HTTP_FAILURE.notFound);
    }
    const { featureAccessSnapshot, session, user } = authorization.value;
    if (
      !isFeatureEnabled(featureAccessSnapshot, featureId, {
        organizationId: session.activeOrganizationId,
        userId: user.id,
      })
    ) {
      throw new HttpFailureError(HTTP_FAILURE.notFound);
    }
    return await inner();
  };
  gatedFeatures.set(gate, featureId);
  return gate;
};
