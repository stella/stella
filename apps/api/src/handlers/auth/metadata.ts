import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { panic } from "better-result";

import { getAgentAuthMetadataBlock } from "@/api/agent-auth/metadata";
import { PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS } from "@/api/handlers/public-cors";
import { CACHE_CONTROL_HEADER } from "@/api/http/cache";
import { getAuth } from "@/api/lib/auth";
import { MCP_PROTOCOL_VERSION_HEADER } from "@/api/mcp/constants";

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

const createAuthMetadataHeaders = () =>
  new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });

/**
 * MCP clients send `MCP-Protocol-Version` on discovery, which makes a
 * browser preflight the request; the preflight has to admit that header and
 * may be reused rather than repeated before every authorization.
 */
export const createAuthMetadataPreflightHeaders = () => {
  const headers = createAuthMetadataHeaders();
  headers.set("Access-Control-Allow-Headers", MCP_PROTOCOL_VERSION_HEADER);
  headers.set(
    "Access-Control-Max-Age",
    String(PUBLIC_CORS_PREFLIGHT_MAX_AGE_SECONDS),
  );
  return headers;
};

const withAuthMetadataHeaders = (response: Response) => {
  const headers = new Headers(response.headers);

  for (const [key, value] of createAuthMetadataHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  headers.delete(CACHE_CONTROL_HEADER);
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

  const upstream = await oauthProviderAuthServerMetadata(auth)(request);
  if (!upstream.ok) {
    return withAuthMetadataHeaders(upstream);
  }

  // better-auth's oauthProvider exposes no metadata-customization hook, so
  // we merge the auth.md `agent_auth` profile block onto the generated
  // RFC 8414 document here.
  const parsed: unknown = await upstream.json();
  const metadata = typeof parsed === "object" && parsed !== null ? parsed : {};
  const body = JSON.stringify({
    ...metadata,
    agent_auth: getAgentAuthMetadataBlock(),
  });

  const headers = new Headers(upstream.headers);
  for (const [key, value] of createAuthMetadataHeaders()) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  headers.delete(CACHE_CONTROL_HEADER);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");

  return new Response(body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText,
  });
};
