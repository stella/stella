import { panic } from "better-result";

import type { RouteNode } from "./route-types.js";

/** Enabled identities from this invocation's authenticated tools/list. */
export type CallerFeatureAccess = {
  capabilities: readonly string[];
  tools: readonly string[];
};

export const hasFeatureCommands = (tree: RouteNode): boolean => {
  switch (tree.kind) {
    case "leaf":
    case "capability-leaf":
      return tree.spec.featureId !== undefined;
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
