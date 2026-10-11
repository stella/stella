/** The route string attached to a synthesized capability handler context. */
export const capabilityRoute = (capabilityId: string): string =>
  `mcp:invoke_capability/${capabilityId}`;
