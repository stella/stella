import { Result } from "better-result";
import { createRemoteJWKSet, jwtVerify } from "jose";

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

const getJWKS = (issuer: string) => {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL("/.well-known/jwks.json", issuer));
  }
  return jwksCache;
};

export const validateToken = async (
  token: string,
  issuer: string,
): Promise<
  Result<{ sub: string; org_id: string; scopes: string[] }, Error>
> => {
  try {
    const { payload } = await jwtVerify(token, getJWKS(issuer), {
      issuer,
      audience: "stella-mcp",
    });
    return Result.ok({
      sub: payload.sub as string,
      org_id: payload.org_id as string,
      scopes: (payload.scopes as string[]) ?? [],
    });
  } catch (error) {
    return Result.err(
      error instanceof Error ? error : new Error("Token validation failed"),
    );
  }
};
