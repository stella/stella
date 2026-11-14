/** The route string attached to a synthesized capability handler context. */
const CAPABILITY_ROUTE_PREFIX = "mcp:invoke_capability/";

export const capabilityRoute = (capabilityId: string): string =>
  `${CAPABILITY_ROUTE_PREFIX}${capabilityId}`;

/** Whether a handler context was synthesized for an MCP capability call. */
export const isCapabilityRoute = (route: string): boolean =>
  route.startsWith(CAPABILITY_ROUTE_PREFIX);
