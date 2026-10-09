import { Result } from "better-result";

import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";
import { authenticateMcpRequest } from "@/api/mcp/auth";

export const authorizeLegalResolveRequest = async (request: Request) => {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  const session = await authenticateMcpRequest(authorization.slice(7));
  if (Result.isError(session) || !hasLawReadScope(session.value.scopes)) {
    return { status: 403 as const, body: { error: "missing_scope" as const } };
  }
  return { status: 200 as const };
};
