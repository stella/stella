import { panic, Result } from "better-result";

import {
  REVIEW_ACCOUNT_DISPOSITION,
  REVIEW_ACCOUNT_REFUSAL_MESSAGE,
} from "@/api/lib/auth/review-account-policy";
import type {
  ReviewAccountDisposition,
  ReviewAccountOperation,
} from "@/api/lib/auth/review-account-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  isSyntheticPrincipal,
  SYNTHETIC_PRINCIPAL,
} from "@/api/lib/synthetic-principal/constants";

import { USER_SESSION_CREDENTIAL_ISSUERS } from "./credential-policy";

export const SYNTHETIC_PRINCIPAL_POLICY = {
  "password-sign-in": "refused",
  "email-code-sign-in":
    USER_SESSION_CREDENTIAL_ISSUERS.confirmationCode.disposition,
  "verify-email": "refused",
  session: "own-organization",
  mcp: USER_SESSION_CREDENTIAL_ISSUERS.oauth.disposition,
  "create-organization": "refused",
  "manage-organization": "refused",
  "send-invitation": USER_SESSION_CREDENTIAL_ISSUERS.invitation.disposition,
  "accept-invitation": USER_SESSION_CREDENTIAL_ISSUERS.invitation.disposition,
  "join-organization": "refused",
  "change-email": "refused",
  "change-password": "refused",
  "enroll-two-factor": "refused",
  "create-api-key": USER_SESSION_CREDENTIAL_ISSUERS.apiKey.disposition,
  "link-identity": "refused",
  "delete-account": "refused",
  "account-control-operation":
    USER_SESSION_CREDENTIAL_ISSUERS.agentDelegation.disposition,
} as const satisfies Record<ReviewAccountOperation, ReviewAccountDisposition>;

export const syntheticPrincipalAuthConfig = {
  email: SYNTHETIC_PRINCIPAL.user.email,
  organizationId: SYNTHETIC_PRINCIPAL.org.id,
};

type SyntheticAccessOptions = {
  email: string;
  operation: ReviewAccountOperation;
  organizationId?: unknown;
};

export const checkSyntheticPrincipalAccess = ({
  email,
  operation,
  organizationId,
}: SyntheticAccessOptions): Result<void, HandlerError> => {
  if (!isSyntheticPrincipal({ email })) {
    return Result.ok();
  }
  const disposition = SYNTHETIC_PRINCIPAL_POLICY[operation];
  switch (disposition) {
    case REVIEW_ACCOUNT_DISPOSITION.ownOrganization:
      if (
        typeof organizationId === "string" &&
        isSyntheticPrincipal({ organizationId })
      ) {
        return Result.ok();
      }
      break;
    case REVIEW_ACCOUNT_DISPOSITION.refused:
      break;
    default:
      disposition satisfies never;
      return panic(`Unhandled account disposition: ${String(disposition)}`);
  }
  return Result.err(
    new HandlerError({
      status: 403,
      code: "account_access_unavailable",
      message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
    }),
  );
};
