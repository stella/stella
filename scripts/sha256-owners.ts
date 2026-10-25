/** Raw hashing is confined to these runtime boundaries. */
export const SHA256_OWNERS = {
  "packages/sha256/src/bun.ts": "Bun incremental and synchronous hashing",
  "packages/sha256/src/node.ts": "Node-compatible private tooling",
  "packages/sha256/src/browser.ts": "Browser WebCrypto hashing",
  "packages/cli/src/sha256.ts": "Published CLI hashing under Node",
  "packages/agent-engine/scripts/mcp-canary-server.ts":
    "MCP canary server bundled for and run by Node",
} as const;
