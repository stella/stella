// Links into the stella web app. The document route
// (apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.document.tsx)
// needs both the entity and its file field; `all` is the matter's default view.

const DEFAULT_WORKSPACE_VIEW_ID = "all";

type BuildSavedEmailUrlOptions = {
  baseUrl: string;
  entityId: string;
  fieldId: string | null;
  workspaceId: string;
};

/** The filed email's document view, or the matter when the field is unknown. */
export const buildSavedEmailUrl = ({
  baseUrl,
  entityId,
  fieldId,
  workspaceId,
}: BuildSavedEmailUrlOptions): string => {
  const matterPath = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (fieldId === null) {
    return new URL(matterPath, baseUrl).toString();
  }
  const url = new URL(
    `${matterPath}/${DEFAULT_WORKSPACE_VIEW_ID}/document`,
    baseUrl,
  );
  url.searchParams.set("entity", entityId);
  url.searchParams.set("field", fieldId);
  return url.toString();
};
