import type {
  MattersSortKey,
  Workspace,
  WorkspaceGroup,
} from "@/routes/_protected.workspaces/-types";

export const getUniqueClientsFromWorkspace = (
  workspaces: Workspace[],
): { id: string; displayName: string }[] => {
  const map = new Map<string, { id: string; displayName: string }>();
  for (const ws of workspaces) {
    if (ws.client) {
      map.set(ws.client.id, ws.client);
    }
  }
  return Array.from(map.values()).toSorted((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
};

export const groupByClient = (
  workspaces: Workspace[],
  noClientLabel: string,
): WorkspaceGroup[] => {
  const groups = new Map<string | null, WorkspaceGroup>();

  for (const ws of workspaces) {
    const key = ws.client?.id ?? null;
    let group = groups.get(key);
    if (!group) {
      group = {
        groupId: key ?? ws.id,
        clientId: key,
        clientName: ws.client?.displayName ?? noClientLabel,
        workspaces: [],
      };
      groups.set(key, group);
    }
    group.workspaces.push(ws);
  }

  const result = [...groups.values()];
  result.sort((a, b) => {
    if (a.clientId === null) {
      return 1;
    }
    if (b.clientId === null) {
      return -1;
    }
    return a.clientName.localeCompare(b.clientName);
  });

  return result;
};

export const compareWorkspacesByKey = (
  a: Workspace,
  b: Workspace,
  key: MattersSortKey,
): number => {
  switch (key) {
    case "name":
      return a.name.localeCompare(b.name);
    case "reference":
      return (a.reference ?? "").localeCompare(b.reference ?? "");
    case "entityCount":
      return a.entityCount - b.entityCount;
    case "lastActivityAt":
      return (
        new Date(a.lastActivityAt).getTime() -
        new Date(b.lastActivityAt).getTime()
      );
    case "createdAt":
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    case "clientName":
      return (a.client?.displayName ?? "").localeCompare(
        b.client?.displayName ?? "",
      );
    default:
      return 0;
  }
};
