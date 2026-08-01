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
