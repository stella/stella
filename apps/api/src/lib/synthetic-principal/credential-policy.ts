import { Result } from "better-result";

import { REVIEW_ACCOUNT_REFUSAL_MESSAGE } from "@/api/lib/auth/review-account-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { isSyntheticPrincipal, SYNTHETIC_PRINCIPAL } from "./constants";
import type { SyntheticSessionAuthorityReader } from "./session-authority";

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
  signedDownload: {
    disposition: "session-bound-ttl",
    maxTtlSeconds: 60,
    owner: "s3-presign",
  },
  signedUpload: { disposition: "refused", owner: "s3-presign" },
  agentRun: { disposition: "refused", owner: "mcp/agent-run-token" },
  agentDelegation: { disposition: "refused", owner: "agent-auth" },
  realtime: { disposition: "refused", owner: "sse" },
} as const satisfies Record<
  string,
  (
    | { disposition: "refused" | "session-bound" }
    | { disposition: "session-bound-ttl"; maxTtlSeconds: number }
  ) & { owner: string }
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

// The issuer type accepts only registry entries classified as refused.
export const checkSessionCredentialIssuer = (
  _issuer: RefusedCredentialIssuer,
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
  return Result.err(
    new HandlerError({
      status: 403,
      code: "account_access_unavailable",
      message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
    }),
  );
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

type SessionBoundTtlIssuerOptions = CredentialPrincipal & {
  fileOrganizationId: string | null | undefined;
  requestedTtlSeconds: number;
  now: Date;
  sessionId: string | null;
  readSessionAuthority: SyntheticSessionAuthorityReader;
};

const sessionCredentialRefusal = () =>
  new HandlerError({
    status: 403,
    code: "account_access_unavailable",
    message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
  });

export const issueSessionBoundCredentialTtl = async (
  issuer: "signedDownload",
  {
    userId,
    organizationId,
    email,
    fileOrganizationId,
    requestedTtlSeconds,
    now,
    sessionId,
    readSessionAuthority,
  }: SessionBoundTtlIssuerOptions,
): Promise<number> => {
  const policy = USER_SESSION_CREDENTIAL_ISSUERS[issuer];
  if (!isSyntheticPrincipal({ userId, organizationId, email })) {
    return requestedTtlSeconds;
  }

  if (
    userId !== SYNTHETIC_PRINCIPAL.user.id ||
    organizationId !== SYNTHETIC_PRINCIPAL.org.id ||
    fileOrganizationId !== SYNTHETIC_PRINCIPAL.org.id
  ) {
    throw sessionCredentialRefusal();
  }

  const authority = await readSessionAuthority({ sessionId, userId, now });
  if (authority === null) {
    throw sessionCredentialRefusal();
  }

  const remainingSeconds = Math.floor(
    (authority.expiresAt.getTime() - now.getTime()) / 1000,
  );
  const ttlSeconds = Math.min(
    requestedTtlSeconds,
    policy.maxTtlSeconds,
    remainingSeconds,
  );
  if (ttlSeconds < 1) {
    throw sessionCredentialRefusal();
  }
  return ttlSeconds;
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
