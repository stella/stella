import type {
  MattersSortKey,
  Workspace,
  WorkspaceGroup,
} from "@/routes/_protected.workspaces/-types";
import { PERSONAL_GROUP_ID } from "@/routes/_protected.workspaces/-types";

export const getUniqueClientsFromWorkspace = (
  workspaces: readonly Workspace[],
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
  workspaces: readonly Workspace[],
): WorkspaceGroup[] => {
  const clientGroups = new Map<
    string,
    Extract<WorkspaceGroup, { type: "client" }>
  >();
  const personalWorkspaces: Workspace[] = [];

  for (const ws of workspaces) {
    const { client } = ws;
    if (!client) {
      personalWorkspaces.push(ws);
      continue;
    }
    const key = client.id;
    let group = clientGroups.get(key);
    if (!group) {
      group = {
        type: "client",
        groupId: key,
        clientId: key,
        clientName: client.displayName,
        responsibleAttorneyName: client.responsibleAttorneyName,
        workspaces: [],
      };
      clientGroups.set(key, group);
    }
    group.workspaces.push(ws);
  }

  const sortedClientGroups = [...clientGroups.values()].toSorted((a, b) =>
    a.clientName.localeCompare(b.clientName),
  );

  if (personalWorkspaces.length === 0) {
    return sortedClientGroups;
  }

  return [
    {
      type: "personal",
      groupId: PERSONAL_GROUP_ID,
      workspaces: personalWorkspaces,
    },
    ...sortedClientGroups,
  ];
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
