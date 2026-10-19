import { Result } from "better-result";

import { REVIEW_ACCOUNT_REFUSAL_MESSAGE } from "@/api/lib/auth/review-account-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { isSyntheticPrincipal } from "./constants";

export const USER_SESSION_CREDENTIAL_ISSUERS = {
  session: { disposition: "session-bound", owner: "synthetic-principal/store" },
  cookieCache: { disposition: "refused", owner: "auth/session-lifetime" },
  collabRoom: { disposition: "session-bound", owner: "folio-collab-rooms" },
  oauth: { disposition: "refused", owner: "auth/review-account-plugin" },
  invitation: { disposition: "refused", owner: "auth/review-account-plugin" },
  inboundEmail: { disposition: "refused", owner: "email/inbound/address" },
  confirmationCode: { disposition: "refused", owner: "confirmation-otp" },
  apiKey: { disposition: "refused", owner: "auth/review-account-plugin" },
  desktopAccount: {
    disposition: "refused",
    owner: "business-registries/desktop/link-grant-store",
  },
  desktopEdit: { disposition: "refused", owner: "desktop-edit-sessions" },
  desktopHandoff: { disposition: "refused", owner: "desktop-edit-handoffs" },
  pdfSigning: { disposition: "refused", owner: "files/pdf-signing/sessions" },
  signedDownload: { disposition: "refused", owner: "s3-presign" },
  signedUpload: { disposition: "refused", owner: "s3-presign" },
  agentRun: { disposition: "refused", owner: "mcp/agent-run-token" },
  agentDelegation: { disposition: "refused", owner: "agent-auth" },
  realtime: { disposition: "refused", owner: "sse" },
} as const satisfies Record<
  string,
  { disposition: "refused" | "session-bound"; owner: string }
>;

type UserSessionCredentialIssuer = keyof typeof USER_SESSION_CREDENTIAL_ISSUERS;
type RefusedCredentialIssuer = {
  [
    Issuer in UserSessionCredentialIssuer
  ]: (typeof USER_SESSION_CREDENTIAL_ISSUERS)[Issuer]["disposition"] extends "refused"
    ? Issuer
    : never;
}[UserSessionCredentialIssuer];

export type CredentialPrincipal = {
  userId: string | null;
  organizationId?: string | null | undefined;
  email?: string | undefined;
};

export const checkSessionCredentialIssuer = (
  issuer: RefusedCredentialIssuer,
  { userId, organizationId, email }: CredentialPrincipal,
): Result<void, HandlerError> => {
  if (
    !isSyntheticPrincipal({
      email,
      userId,
      organizationId,
    })
  ) {
    return Result.ok();
  }
  switch (USER_SESSION_CREDENTIAL_ISSUERS[issuer].disposition) {
    case "refused":
      return Result.err(
        new HandlerError({
          status: 403,
          code: "account_access_unavailable",
          message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
        }),
      );
  }
};

/** Credential SDKs consume refusals through their rejection contract. */
export const requireSessionCredentialIssuer = (
  issuer: RefusedCredentialIssuer,
  principal: CredentialPrincipal,
): void => {
  const access = checkSessionCredentialIssuer(issuer, principal);
  if (Result.isError(access)) {
    throw access.error;
  }
};

export const requireSessionCredentialAuthority = <T>(
  authority: T | null,
): T => {
  if (authority === null) {
    throw new HandlerError({
      status: 403,
      code: "account_access_unavailable",
      message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
    });
  }
  return authority;
};
