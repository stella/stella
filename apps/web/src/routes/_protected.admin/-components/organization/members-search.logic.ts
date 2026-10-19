import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

type SearchableMember = { user: { email: string; name: string } };
type SearchableInvitation = { email: string };

type FilterOrganizationListsOptions<
  TMember extends SearchableMember,
  TInvitation extends SearchableInvitation,
> = {
  invitations: TInvitation[];
  members: TMember[];
  query: string | undefined;
};

export const filterOrganizationLists = <
  TMember extends SearchableMember,
  TInvitation extends SearchableInvitation,
>({
  invitations,
  members,
  query,
}: FilterOrganizationListsOptions<TMember, TInvitation>) => {
  if (!query) {
    return { invitations, members };
  }

  const normalizedQuery = query.toLowerCase();
  return {
    invitations: invitations.filter((invitation) =>
      containsSearchMatchKey(invitation.email.toLowerCase(), normalizedQuery),
    ),
    members: members.filter(
      (member) =>
        containsSearchMatchKey(
          member.user.name.toLowerCase(),
          normalizedQuery,
        ) ||
        containsSearchMatchKey(
          member.user.email.toLowerCase(),
          normalizedQuery,
        ),
    ),
  };
};
