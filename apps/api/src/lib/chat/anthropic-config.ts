// Without the `m` flag, JavaScript `$` matches only at the end of input, so a
// trailing line terminator fails these patterns (unlike PCRE or Python).
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
  // Stella owns the complete tool list and layered prompts on every request.
  // Keep optional SDK mid-conversation rewriting out of this boundary.
  midConversationChannels: false,
});
