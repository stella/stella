import { Result } from "better-result";

import { validateToken } from "@/api/lib/jwks-validator";

export const opencodeAuthMiddleware = async (
  req: Request,
  next: () => Promise<Response>,
): Promise<Response> => {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = auth.slice(7);
  const result = await validateToken(token, new URL(req.url).origin);
  if (Result.isError(result)) {
    return new Response("Invalid token", { status: 401 });
  }
  const headers = new Headers(req.headers);
  headers.set("x-stella-user", result.value.sub);
  headers.set("x-stella-org", result.value.org_id);
  headers.set("x-stella-scopes", result.value.scopes.join(","));
  const forwarded = new Request(req, { headers });
  return next(forwarded);
};
