// Data shapes for the MCP resources -> stricli route-map generator (spec 051
// S5.4). Resources are a small parallel tree to the tool tree: `resources/list`
// projects to `reference list`, and each resource projects to a
// `reference show <name>` leaf that reads it via `resources/read`. Types only.

/** One resource as returned by `resources/list` (the wire fields the CLI uses). */
export type ResourceListing = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};

/**
 * A generated resource leaf: either the `list` enumerator or a per-resource
 * `show` reader carrying the fixed URI it dispatches `resources/read` with.
 */
export type ResourceLeafSpec =
  | { kind: "list"; commandPath: readonly string[] }
  | { kind: "show"; commandPath: readonly string[]; name: string; uri: string };

/** stricli assembly for the resource tree, mirroring the tool `RouteNode`. */
export type ResourceNode =
  | { kind: "leaf"; spec: ResourceLeafSpec }
  | { kind: "route"; children: Record<string, ResourceNode> };
