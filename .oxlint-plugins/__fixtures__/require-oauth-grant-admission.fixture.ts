// oxlint-disable-next-line require-oauth-grant-admission/require-oauth-grant-admission -- raw resource verifier acquisition belongs to the MCP authentication owner
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

// expect-clean: require-oauth-grant-admission/require-oauth-grant-admission
import { verifyOAuthToken } from "@/api/lib/auth/oauth-grant-admission";

export const raw = oauthProviderResourceClient;
export const admitted = verifyOAuthToken;
