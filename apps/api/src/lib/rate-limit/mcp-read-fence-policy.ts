// Four counters scan at most 4 × 257 members; this bounds Lua work to roughly
// a thousand short entries (a few ms), independently of operator configuration.
export const MCP_READ_MAX_ENTRIES = 256;
