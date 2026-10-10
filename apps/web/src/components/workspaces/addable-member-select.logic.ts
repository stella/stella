import { panic } from "better-result";

import type { QueryView } from "@/lib/query-view.logic";

type OrganizationMember = {
  userId: string;
  user: { email: string; image?: string | null | undefined; name: string };
};
type MemberItem = {
  email: string;
  image: string | null | undefined;
  name: string;
  value: string;
};
type AddableMembersView =
  | { type: "pending" }
  | { type: "error" }
  | { type: "empty" }
  | { type: "items"; items: MemberItem[] };

export const addableMembersView = <TError>(
  organization: QueryView<{ members: OrganizationMember[] } | null, TError>,
  members: QueryView<{ userId: string }[], TError>,
): AddableMembersView => {
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
  const ids = new Set(existing.map((member) => member.userId));
  const items = organizationMembers
    .filter((member) => !ids.has(member.userId))
    .map((member) => ({
      email: member.user.email,
      image: member.user.image,
      name: member.user.name,
      value: member.userId,
    }));
  const hasRefetchError =
    (organization.type === "items" &&
      organization.refetchError !== undefined) ||
    (members.type === "items" && members.refetchError !== undefined);
  return items.length || hasRefetchError
    ? { type: "items", items }
    : { type: "empty" };
};
