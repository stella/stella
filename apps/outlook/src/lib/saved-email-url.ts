type BuildSavedEmailUrlOptions = {
  baseUrl: string;
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

export const buildSavedEmailUrl = ({
  baseUrl,
  entityId,
  fieldId,
  workspaceId,
}: BuildSavedEmailUrlOptions): string => {
  const url = new URL(
    `/workspaces/${encodeURIComponent(workspaceId)}/all/document`,
    baseUrl,
  );
  url.searchParams.set("entity", entityId);
  url.searchParams.set("field", fieldId);
  return url.toString();
};
