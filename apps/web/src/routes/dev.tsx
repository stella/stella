import * as React from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

const DEV_VISUAL = {
  controlSizes: "control-sizes",
  inspectorPane: "inspector-pane",
  workspaceTable: "workspace-table",
} as const;

const UiPlayground = import.meta.env.DEV
  ? React.lazy(async () => {
      const module = await import("@/routes/dev/-components/ui-playground");

      return { default: module.UiPlayground };
    })
  : null;

const ControlSizesPlayground = import.meta.env.DEV
  ? React.lazy(async () => {
      const module =
        await import("@/routes/dev/-components/control-sizes-playground");

      return { default: module.ControlSizesPlayground };
    })
  : null;

const InspectorPanePlayground = import.meta.env.DEV
  ? React.lazy(async () => {
      const module =
        await import("@/routes/dev/-components/inspector-pane-playground");

      return { default: module.InspectorPanePlayground };
    })
  : null;

const WorkspaceTablePlayground = import.meta.env.DEV
  ? React.lazy(async () => {
      const module =
        await import("@/routes/dev/-components/workspace-table-playground");

      return { default: module.WorkspaceTablePlayground };
    })
  : null;

const searchSchema = v.object({
  visual: v.optional(
    v.picklist([
      DEV_VISUAL.controlSizes,
      DEV_VISUAL.inspectorPane,
      DEV_VISUAL.workspaceTable,
    ]),
  ),
});

export const Route = createFileRoute("/dev")({
  validateSearch: searchSchema,
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/" });
    }
  },
  component: DevRouteComponent,
});

function DevRouteComponent() {
  const visual = Route.useSearch({ select: (search) => search.visual });

  if (visual === DEV_VISUAL.controlSizes) {
    if (ControlSizesPlayground === null) {
      return null;
    }

    return (
      <React.Suspense fallback={null}>
        <main className="bg-background min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <div className="grid gap-5 py-5 lg:grid-cols-2">
              <ControlSizesPlayground />
            </div>
          </div>
        </main>
      </React.Suspense>
    );
  }

  if (visual === DEV_VISUAL.inspectorPane) {
    if (InspectorPanePlayground === null) {
      return null;
    }

    // No page chrome: the bench sizes its own panes, and anything that
    // bounded them here would answer the question under test.
    return (
      <React.Suspense fallback={null}>
        <main className="bg-background flex min-h-0 flex-1 flex-col overflow-auto p-4">
          <InspectorPanePlayground />
        </main>
      </React.Suspense>
    );
  }

  if (visual === DEV_VISUAL.workspaceTable) {
    if (WorkspaceTablePlayground === null) {
      return null;
    }

    // The results page's chrome, so the bench measures the table in the shape
    // the product gives it: a bounded column, and a page scroller that only
    // engages when the viewport is too short to hold the table's minimum.
    return (
      <React.Suspense fallback={null}>
        <main className="bg-background flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          <WorkspaceTablePlayground />
        </main>
      </React.Suspense>
    );
  }

  if (UiPlayground === null) {
    return null;
  }

  return (
    <React.Suspense fallback={null}>
      <UiPlayground />
    </React.Suspense>
  );
}
