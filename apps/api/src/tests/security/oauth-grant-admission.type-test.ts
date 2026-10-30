import type { InferOk } from "better-result";

import type { ApiAccessTokenSession } from "@/api/lib/auth/api-access-token";
import type { AdmittedMcpSession } from "@/api/lib/auth/oauth-grant-admission";
import type { LegalResolveSession } from "@/api/lib/db/service-client-contract";
import type { McpSession, verifyMcpAccessToken } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";

// Compile-only: raw OAuth credentials cannot cross either admission boundary.
type OAuthAdmissionProofOptions = {
  raw: McpSession;
  admitted: AdmittedMcpSession;
  request: Request;
};

export const oauthAdmissionProof = ({
  raw,
  admitted,
  request,
}: OAuthAdmissionProofOptions) => {
  // @ts-expect-error OAuth credentials need the admission owner's opaque value.
  const legalSession: LegalResolveSession = raw;
  // @ts-expect-error MCP context requires the same admission evidence.
  const rawContext = resolveMcpSessionContext(raw, { request });
  const admittedContext = resolveMcpSessionContext(admitted, { request });
  return { legalSession, rawContext, admittedContext };
};

export const apiAdmissionProof = (
  raw: Omit<ApiAccessTokenSession, "credential">,
) => {
  // @ts-expect-error API sessions require admission evidence from the owner.
  const apiSession: ApiAccessTokenSession = raw;
  return apiSession;
};

type VerifiedMcpToken = InferOk<
  Awaited<ReturnType<typeof verifyMcpAccessToken>>
>;
export const verifierAdmissionProof = (raw: McpSession) => {
  const verified: VerifiedMcpToken = {
    type: "user",
    payload: {},
    // @ts-expect-error A verifier cannot return an unadmitted user session.
    session: raw,
  };
  return verified;
};
