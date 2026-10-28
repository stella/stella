export const matterCardPreviewEnabled = (
  status: string,
  previewRequested: boolean,
) => status === "active" && previewRequested;
