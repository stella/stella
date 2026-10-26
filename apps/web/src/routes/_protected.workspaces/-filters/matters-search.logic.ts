import { filterBySearchQuery } from "@stll/text-normalize";

type Client = {
  displayName: string;
};

type MatterSearchWorkspace = {
  client: Client | null;
  name: string;
  reference: string;
};

type TeamMember = {
  userEmail: string;
  userId: string;
  userName: string;
};

export const filterWorkspacesBySearch = <T extends MatterSearchWorkspace>(
  workspaces: readonly T[],
  search: string,
) =>
  filterBySearchQuery({
    items: workspaces,
    query: search,
    fields: ({ client, name, reference }) => [
      name,
      reference,
      client?.displayName,
    ],
  });

export const filterClientsBySearch = <T extends Client>(
  clients: readonly T[],
  search: string,
) =>
  filterBySearchQuery({
    items: clients,
    query: search,
    fields: ({ displayName }) => [displayName],
  });

export const filterTeamMembersBySearch = <T extends TeamMember>(
  members: readonly T[],
  search: string,
) =>
  filterBySearchQuery({
    items: members,
    query: search,
    fields: ({ userEmail, userId, userName }) => [userName, userEmail, userId],
  });
