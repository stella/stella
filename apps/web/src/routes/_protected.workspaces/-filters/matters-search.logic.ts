import { containsSearchMatchKey } from "@stll/text-normalize/search-match-key";

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
) => {
  const query = search.toLowerCase();
  const hasQuery = search.trim().length > 0;
  return workspaces.filter(
    (workspace) =>
      !hasQuery ||
      containsSearchMatchKey(workspace.name.toLowerCase(), query) ||
      containsSearchMatchKey(workspace.reference.toLowerCase(), query) ||
      (workspace.client !== null &&
        containsSearchMatchKey(
          workspace.client.displayName.toLowerCase(),
          query,
        )),
  );
};

export const filterClientsBySearch = <T extends Client>(
  clients: readonly T[],
  search: string,
) => {
  const query = search.trim().toLowerCase();
  return query
    ? clients.filter((client) =>
        containsSearchMatchKey(client.displayName.toLowerCase(), query),
      )
    : clients;
};

export const filterTeamMembersBySearch = <T extends TeamMember>(
  members: readonly T[],
  search: string,
) => {
  const query = search.trim().toLowerCase();
  return query
    ? members.filter(
        (member) =>
          containsSearchMatchKey(member.userName.toLowerCase(), query) ||
          containsSearchMatchKey(member.userEmail.toLowerCase(), query) ||
          containsSearchMatchKey(member.userId.toLowerCase(), query),
      )
    : members;
};
