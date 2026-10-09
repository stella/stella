import { panic } from "better-result";

import type { RouteNode } from "./route-types.js";

type ProjectDeploymentCommandsArgs = {
  tree: RouteNode;
  /** Undefined means this deployment has supplied no current evidence. */
  featureOmittedTools: readonly string[] | undefined;
  featureOmittedCapabilities: readonly string[] | undefined;
};

export const projectDeploymentCommands = ({
  tree,
  featureOmittedTools,
  featureOmittedCapabilities,
}: ProjectDeploymentCommandsArgs): RouteNode => {
  const tools = new Set(featureOmittedTools);
  const capabilities = new Set(featureOmittedCapabilities);
  const project = (node: RouteNode): RouteNode | null => {
    switch (node.kind) {
      case "leaf":
        return tools.has(node.spec.toolName) ||
          (node.spec.feature !== undefined && featureOmittedTools === undefined)
          ? null
          : node;
      case "capability-leaf":
        return capabilities.has(node.spec.capabilityId) ||
          (node.spec.feature !== undefined &&
            featureOmittedCapabilities === undefined)
          ? null
          : node;
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
