// oxlint-disable-next-line require-oauth-grant-admission/require-oauth-grant-admission -- raw resource verifier acquisition belongs to the MCP authentication owner
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

// expect-clean: require-oauth-grant-admission/require-oauth-grant-admission
import { verifyOAuthToken } from "@/api/mcp/auth";

import * as mcpAuth from "@/api/mcp/auth";

// oxlint-disable-next-line require-oauth-grant-admission/require-oauth-grant-admission -- fixture: the raw provider verifier getter must stay private to mcp/auth.ts
export const rawGetter = mcpAuth.getVerifyBearerToken;
export const raw = oauthProviderResourceClient;
export const admitted = verifyOAuthToken;
