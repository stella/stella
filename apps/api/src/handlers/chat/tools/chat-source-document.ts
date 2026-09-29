export type ChatSourceDocument = {
  entityId: string;
  entityRef?: string;
  kind: string;
  matterRef?: string;
  mention?: string;
  mimeType: string | null;
  title: string;
  workspaceId: string | null;
};
