import { panic } from "better-result";

import type { MemberOption } from "@/components/member-combobox";
import type { QueryView } from "@/lib/query-view.logic";

type OrganizationMember = {
  userId: string;
  user: { email: string; image?: string | null | undefined; name: string };
};
type AddMemberCandidates =
  | { type: "pending" }
  | { type: "error" }
  | { type: "empty" }
  | {
      type: "items";
      /** Every organization member, those already on the matter included. */
      members: MemberOption[];
      /** Who is already on the matter, listed but not choosable. */
      existingUserIds: ReadonlySet<string>;
    };

/**
 * The organization's members as candidates for one matter. People already on
 * the matter stay in the list so a search for them explains why they cannot
 * be added; the list is empty only when nobody is left to add.
 */
export const addMemberCandidates = <TError>(
  organization: QueryView<{ members: OrganizationMember[] } | null, TError>,
  members: QueryView<{ userId: string }[], TError>,
): AddMemberCandidates => {
  if (organization.type === "error" || members.type === "error") {
    return { type: "error" };
  }
  if (organization.type === "pending" || members.type === "pending") {
    return { type: "pending" };
  }
  let existing: { userId: string }[];
  switch (members.type) {
    case "empty":
      existing = [];
      break;
    case "items":
      existing = members.items;
      break;
    default:
      members satisfies never;
      return panic("Unhandled member query state");
  }
  let organizationMembers: OrganizationMember[];
  switch (organization.type) {
    case "empty":
      organizationMembers = [];
      break;
    case "items":
      organizationMembers =
        organization.items === null ? [] : organization.items.members;
      break;
    default:
      organization satisfies never;
      return panic("Unhandled organization query state");
  }
  const existingUserIds = new Set(existing.map((member) => member.userId));
  const candidates = organizationMembers.map((member) => ({
    email: member.user.email,
    image: member.user.image ?? null,
    name: member.user.name,
    userId: member.userId,
  }));
  const hasRefetchError =
    (organization.type === "items" &&
      organization.refetchError !== undefined) ||
    (members.type === "items" && members.refetchError !== undefined);
  const anyoneToAdd = candidates.some(
    (candidate) => !existingUserIds.has(candidate.userId),
  );
  return anyoneToAdd || hasRefetchError
    ? { type: "items", members: candidates, existingUserIds }
    : { type: "empty" };
};
