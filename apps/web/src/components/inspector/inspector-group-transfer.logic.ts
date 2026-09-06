import type {
  ChatTab,
  FileTab,
  InspectorTab,
} from "@/components/inspector/inspector-tabs-store";

export type InspectorGroupTransferPlan =
  | { type: "assign" }
  | { type: "confirm-chat-context"; workspaceId: string }
  | { type: "confirm-file-copy"; workspaceId: string };

type InspectorGroupTransferTab =
  | Pick<ChatTab, "contextMatterIds" | "type" | "workspaceId">
  | Pick<FileTab, "type" | "workspaceId">
  | { type: Exclude<InspectorTab["type"], "chat" | "pdf"> };

const matterWorkspaceIdFromGroup = (groupId: string | null): string | null => {
  if (!groupId?.startsWith("matter:")) {
    return null;
  }
  const workspaceId = groupId.slice("matter:".length);
  return workspaceId.length > 0 ? workspaceId : null;
};

export const planInspectorGroupTransfer = (
  tab: InspectorGroupTransferTab,
  groupId: string | null,
): InspectorGroupTransferPlan => {
  const workspaceId = matterWorkspaceIdFromGroup(groupId);
  if (workspaceId === null) {
    return { type: "assign" };
  }

  if (
    tab.type === "chat" &&
    tab.workspaceId !== workspaceId &&
    !tab.contextMatterIds.includes(workspaceId)
  ) {
    return { type: "confirm-chat-context", workspaceId };
  }

  if (tab.type === "pdf" && tab.workspaceId !== workspaceId) {
    return { type: "confirm-file-copy", workspaceId };
  }

  return { type: "assign" };
};
