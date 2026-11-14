import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

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

  return {
    invitations: filterBySearchQuery({
      items: invitations,
      query,
      fields: ({ email }) => [email],
    }),
    members: filterBySearchQuery({
      items: members,
      query,
      fields: ({ user }) => [user.name, user.email],
    }),
  };
};
