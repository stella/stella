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

import { listMcpResources } from "@/api/mcp/resources";
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

// The resource surface (spec 051 S5.4) is generated the same way: project
// `resources/list` to its wire fields so the CLI's `reference` tree never drifts
// from the server's static resources. The set is mode-independent; export the
// default-mode projection.
type ResourceListing = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

const resourceListings: ResourceListing[] = [];
for (const resource of listMcpResources("default")) {
  const listing: ResourceListing = { uri: resource.uri, name: resource.name };
  if (resource.title !== undefined) {
    listing.title = resource.title;
  }
  if (resource.description !== undefined) {
    listing.description = resource.description;
  }
  if (resource.mimeType !== undefined) {
    listing.mimeType = resource.mimeType;
  }
  resourceListings.push(listing);
}

const resourceSnapshotPath = new URL(
  "../../../packages/cli/src/generated/resources-snapshot.json",
  import.meta.url,
);

await Bun.write(
  resourceSnapshotPath,
  `${JSON.stringify(resourceListings, null, 2)}\n`,
);

process.stderr.write(
  `Wrote ${resourceListings.length} resource listings to ${resourceSnapshotPath.pathname}\n`,
);

// The registry transitively pulls in `@/api/lib/sse.ts`, which opens a
// Redis subscriber connection at import time (for cross-instance SSE
// broadcast) and never unrefs it. That's correct for the long-running API
// process but leaves this one-off script's event loop open indefinitely.
// The export is done at this point, so exit explicitly instead of waiting
// on a handle this script never needed.
process.exit(0);
