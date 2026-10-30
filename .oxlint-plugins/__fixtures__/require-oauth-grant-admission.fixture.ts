// oxlint-disable-next-line require-oauth-grant-admission/require-oauth-grant-admission -- raw resource verification belongs to the admission owner
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

export const raw = oauthProviderResourceClient;
