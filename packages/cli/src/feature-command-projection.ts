import { panic } from "better-result";

import type { CapabilityCatalogEntry } from "./generate-capability-tree.js";
import type { RouteNode } from "./route-types.js";

/** Enabled identities from this invocation's authenticated tools/list. */
export type CallerFeatureAccess = {
  capabilities: readonly string[];
  tools: readonly string[];
  conditionalInputs?: Readonly<
    Record<string, CapabilityCatalogEntry["inputSchema"]>
  >;
};

export const hasFeatureCommands = (tree: RouteNode): boolean => {
  switch (tree.kind) {
    case "leaf":
      return tree.spec.featureId !== undefined;
    case "capability-leaf":
      return (
        tree.spec.featureId !== undefined ||
        tree.spec.featureAccess === "conditional"
      );
    case "route":
      return Object.values(tree.children).some(hasFeatureCommands);
    default: {
      tree satisfies never;
      return panic("Unexpected command node");
    }
  }
};

type ProjectFeatureCommandsArgs = {
  tree: RouteNode;
  featureAccess: CallerFeatureAccess | undefined;
};

export const projectFeatureCommands = ({
  tree,
  featureAccess,
}: ProjectFeatureCommandsArgs): RouteNode => {
  const capabilities = new Set(featureAccess?.capabilities);
  const tools = new Set(featureAccess?.tools);
  const project = (node: RouteNode): RouteNode | null => {
    switch (node.kind) {
      case "leaf":
        return node.spec.featureId === undefined ||
          tools.has(node.spec.toolName)
          ? node
          : null;
      case "capability-leaf":
        if (node.spec.featureAccess === "conditional") {
          return capabilities.has(node.spec.capabilityId) ||
            featureAccess?.conditionalInputs?.[node.spec.capabilityId] !==
              undefined
            ? node
            : null;
        }
        return node.spec.featureId === undefined ||
          capabilities.has(node.spec.capabilityId)
          ? node
          : null;
      case "route": {
        const children = new Map<string, RouteNode>();
        let projection: "unchanged" | "changed" = "unchanged";
        for (const [name, child] of Object.entries(node.children)) {
          const visible = project(child);
          if (visible !== child) {
            projection = "changed";
          }
          if (visible !== null) {
            children.set(name, visible);
          }
        }
        if (children.size === 0) {
          return null;
        }
        return projection === "unchanged"
          ? node
          : { ...node, children: Object.fromEntries(children) };
      }
      default: {
        node satisfies never;
        return panic("Unexpected command node");
      }
    }
  };
  return project(tree) ?? { kind: "route", children: {} };
};
