// Dev-only exporter: projects the MCP tool registry
// (`DEFAULT_MCP_TOOL_DEFINITIONS`) down to the four `tools/list` wire fields and
// writes a JSON snapshot that `@stll/cli`'s codegen consumes.
//
// Why a snapshot instead of importing the registry from `@stll/cli` directly:
// `static-tool-definitions.ts` transitively imports `@/api/env`, which eagerly
// validates the full API environment (REDIS_URL, BETTER_AUTH_*, GOTENBERG_*,
// ...) at module load. Running that inside `apps/api` (where the env resolves)
// and emitting a plain JSON file keeps the published `@stll/cli` package free of
// any import — type or value — reachable from `apps/api`. Regenerate with
// `bun run codegen` from `packages/cli` (which runs this first, then the pure
// generator). The snapshot is committed, so registry drift shows up as a diff.

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

// The four wire fields exposed by `tools/list` (scope/feature/access/anonymized
// are server-internal and never leave the server).
type RegistryToolListing = {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
};

const listings: RegistryToolListing[] = [];
for (const tool of DEFAULT_MCP_TOOL_DEFINITIONS) {
  listings.push({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations === undefined
      ? {}
      : { annotations: tool.annotations }),
  });
}

const snapshotPath = new URL(
  "../../../packages/cli/src/generated/registry-snapshot.json",
  import.meta.url,
);

await Bun.write(snapshotPath, `${JSON.stringify(listings, null, 2)}\n`);

process.stderr.write(
  `Wrote ${listings.length} tool listings to ${snapshotPath.pathname}\n`,
);
