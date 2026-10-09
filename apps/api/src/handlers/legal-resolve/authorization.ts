import { Result } from "better-result";

import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { mayReadPublicLawForOrganization } from "@/api/lib/usage/organization-public-law-access";
import { authenticateMcpRequest } from "@/api/mcp/auth";

export type LegalResolveAuthorizationDependencies = {
  authenticate?: typeof authenticateMcpRequest;
  mayReadPublicLaw?: (
    organizationId: SafeId<"organization">,
  ) => ReturnType<typeof mayReadPublicLawForOrganization>;
  publicLawEnabled?: () => boolean;
};

export const authorizeLegalResolveRequest = async (
  request: Request,
  {
    authenticate = authenticateMcpRequest,
    mayReadPublicLaw: readPublicLaw = mayReadPublicLawForOrganization,
    publicLawEnabled = () => isDeploymentFeatureEnabled("FEATURE_PUBLIC_LAW"),
  }: LegalResolveAuthorizationDependencies = {},
) => {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  const session = await authenticate(authorization.slice(7));
  if (
    Result.isError(session) ||
    !hasLawReadScope(session.value.scopes) ||
    !publicLawEnabled()
  ) {
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
  const entitled = await readPublicLaw(organizationId);
  if (Result.isError(entitled)) {
    return {
      status: 503 as const,
      body: { error: "access_unavailable" as const },
    };
  }
  if (!entitled.value) {
    return { status: 403 as const, body: { error: "not_entitled" as const } };
  }
  return { status: 200 as const, session: session.value };
};
