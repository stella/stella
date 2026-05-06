import type { WorkspacesData } from "@/routes/_protected.workspaces/-queries";

export type Workspace = WorkspacesData["workspaces"][number];

export type MattersSortKey =
  | "name"
  | "reference"
  | "entityCount"
  | "lastActivityAt"
  | "createdAt"
  | "clientName";

export type MattersColumnId =
  | "client"
  | "reference"
  | "entityCount"
  | "lastActivityAt"
  | "createdAt";

export const PERSONAL_GROUP_ID = "personal";

export type WorkspaceGroup =
  | {
      type: "client";
      groupId: string;
      clientId: string;
      clientName: string;
      responsibleAttorneyName: string | null;
      workspaces: Workspace[];
    }
  | {
      type: "personal";
      groupId: typeof PERSONAL_GROUP_ID;
      workspaces: Workspace[];
    };

export const ALL_COLUMNS = [
  "client",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
] as const satisfies readonly MattersColumnId[];
