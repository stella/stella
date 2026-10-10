import { SERVICE_CLIENT_PRINCIPAL } from "@/api/lib/service-client-contract";
import type { ServiceOAuthPrincipal } from "@/api/lib/service-client-contract";
import type { McpSession } from "@/api/mcp/auth";

/** Service principals exist only at this public-law boundary. */
export type LegalResolveSession = McpSession | ServiceOAuthPrincipal;

export const isServiceResolveSession = (
  session: LegalResolveSession,
): session is ServiceOAuthPrincipal =>
  "type" in session && session.type === SERVICE_CLIENT_PRINCIPAL;
