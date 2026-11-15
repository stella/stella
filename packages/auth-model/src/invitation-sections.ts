import type { InvitationStatus } from "better-auth/plugins/organization";

export type { InvitationStatus } from "better-auth/plugins/organization";

export type InvitationSection = "pending" | "past" | "hidden";

export const INVITATION_SECTIONS = {
  pending: "pending",
  accepted: "hidden",
  rejected: "past",
  canceled: "past",
} as const satisfies Record<InvitationStatus, InvitationSection>;

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  return typeof value === "string" && Object.hasOwn(INVITATION_SECTIONS, value);
}

type InvitationSectionInput = {
  status: InvitationStatus;
  expiresAt: Date | string;
};

type InvitationClassification = {
  section: InvitationSection;
  status: InvitationStatus | "expired";
};

export function classifyInvitation(
  invitation: InvitationSectionInput,
  now: Date,
): InvitationClassification {
  if (
    invitation.status === "pending" &&
    new Date(invitation.expiresAt).getTime() <= now.getTime()
  ) {
    return { section: "past", status: "expired" };
  }

  return {
    section: INVITATION_SECTIONS[invitation.status],
    status: invitation.status,
  };
}
