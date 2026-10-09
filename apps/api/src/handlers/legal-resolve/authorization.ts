import { Result } from "better-result";
import { decodeJwt } from "jose";

import { mayReadPublicLawForOrganization } from "@/api/db/root";
import { admitLawRead } from "@/api/handlers/legal-resolve/admission";
import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import { captureRequestError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { authenticateMcpRequest } from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import {
  McpOrganizationAccessError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

export type LegalResolveAuthorizationDependencies = {
  authenticate?: typeof authenticateMcpRequest;
  captureError?: typeof captureRequestError;
  mayReadPublicLaw?: (
    organizationId: SafeId<"organization">,
  ) => ReturnType<typeof mayReadPublicLawForOrganization>;
  publicLawEnabled?: () => boolean;
  resolveSessionContext?: (
    ...args: Parameters<typeof resolveMcpSessionContext>
  ) => Promise<unknown>;
};

const legalResolveAuthenticationMode = (token: string) => {
  const decoded = Result.try(() => decodeJwt(token));
  if (Result.isError(decoded)) {
    return "law" as const;
  }
  const audiences = Array.isArray(decoded.value.aud)
    ? decoded.value.aud
    : [decoded.value.aud];
  return audiences.includes(getMcpResourceUrl("default"))
    ? ("default" as const)
    : ("law" as const);
};

export const authorizeLegalResolveRequest = async (
  request: Request,
  {
    authenticate = authenticateMcpRequest,
    captureError = captureRequestError,
    mayReadPublicLaw: readPublicLaw = mayReadPublicLawForOrganization,
    publicLawEnabled = () => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
    resolveSessionContext = resolveMcpSessionContext,
  }: LegalResolveAuthorizationDependencies = {},
) => {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  const token = authorization.slice(7);
  const session = await authenticate(token, {
    mode: legalResolveAuthenticationMode(token),
  });
  if (Result.isError(session)) {
    if (session.error instanceof McpTokenVerificationError) {
      captureError(session.error, {
        request,
        context: { source: "legal-resolve", phase: "authentication" },
      });
      return {
        status: 503 as const,
        body: { error: "access_unavailable" as const },
      };
    }
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  if (!hasLawReadScope(session.value.scopes)) {
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  const liveSession = await Result.tryPromise({
    try: async () => await resolveSessionContext(session.value, { request }),
    catch: (error) => error,
  });
  if (Result.isError(liveSession)) {
    if (!(liveSession.error instanceof McpOrganizationAccessError)) {
      captureError(liveSession.error, {
        request,
        context: { source: "legal-resolve", phase: "session-resolution" },
      });
      return {
        status: 503 as const,
        body: { error: "access_unavailable" as const },
      };
    }
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  const organizationId = parseAuthProviderId<"organization">(
    session.value.organizationId,
  );
  if (organizationId === null) {
    return {
      status: 503 as const,
      body: { error: "access_unavailable" as const },
    };
  }
  const admission = await admitLawRead({
    organizationId,
    mayReadPublicLaw: readPublicLaw,
    publicLawEnabled,
  });
  if (Result.isError(admission)) {
    if (admission.error.type === "access_unavailable") {
      return {
        status: 503 as const,
        body: { error: "access_unavailable" as const },
      };
    }
    return {
      status: 403 as const,
      body: { error: admission.error.type },
    };
  }
  return {
    status: 200 as const,
    session: session.value,
    admission: admission.value,
  };
};
