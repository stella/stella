import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "workspace-view-params",
  capability: "The matter view a web navigation opens under",
  owner: [
    "apps/web/src/lib/workspaces/view-params.logic.ts",
    "apps/web/src/lib/workspaces/use-workspace-view-params.ts",
  ],
  summary:
    "resolveWorkspaceViewParams keeps the view on screen for a destination in its matter and falls back to DEFAULT_WORKSPACE_VIEW_ID, the `$viewId` slug the matter route resolves to its first view. " +
    "useWorkspaceViewParams reads the view on screen from the route match (useCurrentWorkspaceView in render, getCurrentWorkspaceView(router) in a handler; no-view-id-from-path rejects parsing it from the URL path); isWorkspaceViewId is the route's segment check.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-literal-view-id/no-literal-view-id",
    reason:
      "Web code rejects the default slug in any view-id position outside the owner, so a navigation cannot drop the reader's view by hardcoding it.",
  },
} as const satisfies OwnershipEntry;
