// THE resource-tree generator (spec 051 S5.4), mirroring `generateRouteMap`:
// pure, deterministic, no I/O. Given a `resources/list` projection it emits a
// `reference` route with a `list` enumerator and one `show <name>` leaf per
// resource, so the tree is generated (never drifts) yet still fully offline.
// Both call sites (build-time codegen and the runtime path) share this function.

import { RouteGenerationError } from "./generate-route-map.js";
import type { ResourceListing, ResourceNode } from "./resource-types.js";

/** snake_case, camelCase, or a `stella://` uri path segment -> kebab-case. */
const kebabCase = (segment: string): string =>
  segment
    .replace(/_/gu, "-")
    .replace(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();

/**
 * Fold a `resources/list` projection into a `reference` resource tree. `list`
 * enumerates; each resource becomes a `show <name>` leaf keyed by its
 * kebab-cased name. A duplicate resource name is a hard generation error.
 */
export const generateResourceTree = (
  resources: readonly ResourceListing[],
): ResourceNode => {
  const showChildren: Record<string, ResourceNode> = {};

  for (const resource of resources) {
    const key = kebabCase(resource.name);
    if (showChildren[key] !== undefined) {
      throw new RouteGenerationError(
        `Duplicate resource command 'reference show ${key}' (uri ${resource.uri})`,
      );
    }
    showChildren[key] = {
      kind: "leaf",
      spec: {
        kind: "show",
        commandPath: ["reference", "show", key],
        name: resource.name,
        uri: resource.uri,
      },
    };
  }

  return {
    kind: "route",
    children: {
      list: {
        kind: "leaf",
        spec: { kind: "list", commandPath: ["reference", "list"] },
      },
      show: { kind: "route", children: showChildren },
    },
  };
};
