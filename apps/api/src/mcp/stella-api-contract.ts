// Public protocol/revision contract advertised by protected-resource
// discovery. CLI package versions are deliberately absent: compatibility is a
// property of the wire protocol and capabilities, not release numbering.
// Plain data with no environment access, so contract checks can read it
// without configuring the API.
export const STELLA_API_CONTRACT = {
  // 3: capability execution is split into read_capability and write_capability.
  // Clients built for the mixed executor refuse this protocol before dispatch.
  protocol: 3,
  revision: 1,
  capabilities: {
    "document-version-upload": 1,
    "mcp-v2-transport": 1,
  },
} as const;

// Retained as a response header and in the legacy discovery object for clients
// published before `stella_contract` existed.
export const STELLA_MCP_API_CONTRACT_VERSION = STELLA_API_CONTRACT.protocol;
