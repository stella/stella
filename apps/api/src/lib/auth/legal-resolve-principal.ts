import type { McpSession } from "@/api/mcp/auth";

import { SERVICE_CLIENT_PRINCIPAL } from "./service-client-policy";
import type { ServiceOAuthPrincipal } from "./service-client-policy";

/** Service principals exist only at this public-law boundary. */
export type LegalResolveSession = McpSession | ServiceOAuthPrincipal;

export const isServiceResolveSession = (
  session: LegalResolveSession,
): session is ServiceOAuthPrincipal =>
  "type" in session && session.type === SERVICE_CLIENT_PRINCIPAL;
