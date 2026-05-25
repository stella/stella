import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { panic } from "better-result";

import { getAuth } from "@/api/lib/auth";

type AuthWithOAuthServerConfig = ReturnType<typeof getAuth> & {
  api: {
    getOAuthServerConfig: (...args: unknown[]) => unknown;
  };
};

const hasOAuthServerConfig = (
  auth: ReturnType<typeof getAuth>,
): auth is AuthWithOAuthServerConfig => {
  if (typeof auth !== "object") {
    return false;
  }

  if (!("api" in auth)) {
    return false;
  }

  const { api } = auth;
  if (typeof api !== "object") {
    return false;
  }

  return (
    "getOAuthServerConfig" in api &&
    typeof api.getOAuthServerConfig === "function"
  );
};

export const createAuthMetadataHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=300",
  });

const withAuthMetadataHeaders = (response: Response) => {
  const headers = new Headers(response.headers);

  for (const [key, value] of createAuthMetadataHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export const handleOAuthAuthorizationServerMetadataRequest = async (
  request: Request,
): Promise<Response> => {
  const auth = getAuth();
  if (!hasOAuthServerConfig(auth)) {
    panic("OAuth provider metadata endpoint is unavailable");
  }

  return withAuthMetadataHeaders(
    await oauthProviderAuthServerMetadata(auth)(request),
  );
};
