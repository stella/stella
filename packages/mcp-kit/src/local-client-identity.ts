import {
  LOCAL_CLIENT_IDENTITY_HEADER,
  localClientIdentity,
} from "@stll/api-contract/local-client-identity";

/** Headers for an npm-installed MCP server that calls the Stella API. */
export const localMcpClientHeaders = (version: string): Headers =>
  new Headers({
    [LOCAL_CLIENT_IDENTITY_HEADER]: localClientIdentity("mcp-kit", version),
  });
