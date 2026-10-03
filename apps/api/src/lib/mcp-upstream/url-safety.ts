export const canonicalMcpResourceUrl = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  while (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
};

type McpResourceMatchesConnectorOptions = {
  connectorUrl: string;
  resourceUrl: string;
};

export const mcpResourceMatchesConnector = ({
  connectorUrl,
  resourceUrl,
}: McpResourceMatchesConnectorOptions): boolean => {
  const connector = new URL(canonicalMcpResourceUrl(connectorUrl));
  const resource = new URL(canonicalMcpResourceUrl(resourceUrl));
  if (connector.origin !== resource.origin) {
    return false;
  }
  return (
    resource.pathname === "/" ||
    connector.pathname === resource.pathname ||
    connector.pathname.startsWith(`${resource.pathname}/`)
  );
};

export const mcpWellKnownProtectedResourceUrls = (mcpUrl: URL): URL[] => {
  const root = new URL("/.well-known/oauth-protected-resource", mcpUrl.origin);
  const pathScoped = new URL(
    `/.well-known/oauth-protected-resource${mcpUrl.pathname}`,
    mcpUrl.origin,
  );

  return mcpUrl.pathname === "/" ? [root] : [pathScoped, root];
};

export const authorizationServerMetadataUrls = (
  authorizationServerUrl: URL,
): URL[] => {
  if (authorizationServerUrl.pathname === "/") {
    return [
      new URL(
        "/.well-known/oauth-authorization-server",
        authorizationServerUrl.origin,
      ),
      new URL(
        "/.well-known/openid-configuration",
        authorizationServerUrl.origin,
      ),
    ];
  }

  const path = authorizationServerUrl.pathname.replace(/\/$/u, "");

  return [
    new URL(
      `/.well-known/oauth-authorization-server${path}`,
      authorizationServerUrl.origin,
    ),
    new URL(
      `/.well-known/openid-configuration${path}`,
      authorizationServerUrl.origin,
    ),
    new URL(`${path}/.well-known/openid-configuration`, authorizationServerUrl),
  ];
};
