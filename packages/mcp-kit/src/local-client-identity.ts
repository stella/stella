const LOCAL_CLIENT_IDENTITY_HEADER = "x-stella-local-client";

/** Headers for an npm-installed MCP server that calls the Stella API. */
export const localMcpClientHeaders = (version: string): Headers =>
  new Headers({
    [LOCAL_CLIENT_IDENTITY_HEADER]: `mcp-kit/${version}`,
  });
