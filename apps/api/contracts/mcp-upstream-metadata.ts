import type {
  BoundOAuthMetadata,
  ProtectedResourceMetadata,
  UpstreamAuthorizationServerMetadata,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshOAuthToken,
  registerOAuthClient,
} from "@/api/lib/mcp-upstream/oauth";

declare const discoveredMetadata: {
  authorizationServer: UpstreamAuthorizationServerMetadata;
  protectedResource: ProtectedResourceMetadata;
};
declare const boundMetadata: BoundOAuthMetadata;

boundMetadata satisfies Parameters<typeof buildAuthorizeUrl>[0]["metadata"];
boundMetadata satisfies Parameters<typeof registerOAuthClient>[0]["metadata"];
boundMetadata satisfies Parameters<
  typeof exchangeAuthorizationCode
>[0]["metadata"];
boundMetadata satisfies Parameters<typeof refreshOAuthToken>[0]["metadata"];

// @ts-expect-error authorization requires bound metadata
discoveredMetadata satisfies Parameters<
  typeof buildAuthorizeUrl
>[0]["metadata"];
// @ts-expect-error registration requires bound metadata
discoveredMetadata satisfies Parameters<
  typeof registerOAuthClient
>[0]["metadata"];
// @ts-expect-error code exchange requires bound metadata
discoveredMetadata satisfies Parameters<
  typeof exchangeAuthorizationCode
>[0]["metadata"];
// @ts-expect-error refresh requires bound metadata
discoveredMetadata satisfies Parameters<
  typeof refreshOAuthToken
>[0]["metadata"];
