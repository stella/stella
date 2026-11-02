import { MCP_REGISTRY_VERSION_HEADER } from "@stll/api-contract/mcp-registry";

export const withMcpRegistryVersionHeader = (
  response: Response,
  registryVersion: string | undefined,
): Response =>
  registryVersion === undefined
    ? response
    : new Response(response.body, {
        headers: new Headers({
          ...Object.fromEntries(response.headers),
          [MCP_REGISTRY_VERSION_HEADER]: registryVersion,
        }),
        status: response.status,
        statusText: response.statusText,
      });
