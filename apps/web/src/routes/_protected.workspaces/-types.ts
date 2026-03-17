import type { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

type WorkspacesQueryFn = Exclude<
  (typeof workspacesOptions)["queryFn"],
  undefined
>;
type WorkspacesData = Awaited<ReturnType<WorkspacesQueryFn>>;
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

export type WorkspaceGroup = {
  groupId: string;
  clientId: string | null;
  clientName: string;
  workspaces: Workspace[];
};

export const ALL_COLUMNS: MattersColumnId[] = [
  "client",
  "reference",
  "entityCount",
  "lastActivityAt",
  "createdAt",
];
