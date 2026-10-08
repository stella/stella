export const ANTHROPIC_WORKSPACE_ID_PATTERN = "^[A-Za-z0-9_-]+$";
export const OPTIONAL_ANTHROPIC_WORKSPACE_ID_PATTERN = "^[A-Za-z0-9_-]*$";

/** Headers shared by the settings probe and every Anthropic SDK request. */
export const anthropicWorkspaceHeaders = (
  anthropicWorkspaceId: string | undefined,
) =>
  anthropicWorkspaceId === undefined
    ? {}
    : { "anthropic-workspace-id": anthropicWorkspaceId };

export const anthropicClientOptions = (
  anthropicWorkspaceId: string | undefined,
) => ({
  defaultHeaders: anthropicWorkspaceHeaders(anthropicWorkspaceId),
});
