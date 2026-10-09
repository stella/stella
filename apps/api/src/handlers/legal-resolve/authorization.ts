import { Result } from "better-result";

import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { authenticateMcpRequest } from "@/api/mcp/auth";

type LegalResolveAuthorizationDependencies = {
  authenticate?: typeof authenticateMcpRequest;
  publicLawEnabled?: () => boolean;
};

export const authorizeLegalResolveRequest = async (
  request: Request,
  {
    authenticate = authenticateMcpRequest,
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
  return { status: 200 as const, session: session.value };
};
