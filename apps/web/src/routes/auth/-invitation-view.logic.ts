import { panic } from "better-result";

import { isOrganizationRoleName } from "@stll/permissions/role-grants";

import { authClient } from "@/lib/auth-client";

/** The two answers where the next step is signing in differently. */
export const INVITATION_REFUSALS = {
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: {
    reason: "errors.apiCodes.invitationEmailUnverified",
    nextStep: "auth.invitation.verifyEmailHint",
  },
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: {
    reason: "errors.apiCodes.invitationOtherRecipient",
    nextStep: "auth.invitation.wrongAccountHint",
  },
} as const;

export type InvitationRefusalCode = keyof typeof INVITATION_REFUSALS;

const isInvitationRefusalCode = (
  code: string | undefined,
): code is InvitationRefusalCode =>
  code !== undefined && Object.hasOwn(INVITATION_REFUSALS, code);

/** An invitation this account may answer, why the server refused to show it, or nothing to show. */
export const loadInvitationView = async (invitationId: string) => {
  const { data, error } = await authClient.organization.getInvitation({
    query: { id: invitationId },
  });

  if (isInvitationRefusalCode(error?.code)) {
    return { type: "refused", code: error.code } as const;
  }

  if (data?.status !== "pending") {
    return { type: "missing" } as const;
  }

  // The client types the role without validating the response; the sentence
  // naming it has a branch per known role only.
  if (!isOrganizationRoleName(data.role)) {
    return panic(
      `Invitation carries an unknown organization role: ${String(data.role)}`,
    );
  }

  return { type: "invitation", invitation: data } as const;
};
