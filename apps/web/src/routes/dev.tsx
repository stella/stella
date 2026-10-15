import type { ComponentType, ReactElement } from "react";

import { createFileRoute } from "@tanstack/react-router";

import { visualRegistry } from "@/routes/dev/-visual-metadata";
import type { VisualLayout } from "@/routes/dev/-visual-metadata";
import {
  VisualPlayground,
  visualSearchSchema,
} from "@/routes/dev/-visual-registry";

type LayoutProps = { children: ReactElement };

const visualLayouts = {
  plain: ({ children }: LayoutProps) => children,
  "control-sizes": ({ children }: LayoutProps) => (
    <div className="min-h-0 flex-1">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-5 py-5 lg:grid-cols-2">{children}</div>
      </div>
    </div>
  ),
  "inspector-pane": ({ children }: LayoutProps) => (
    <div className="flex min-h-0 flex-1 flex-col p-4">{children}</div>
  ),
  "provision-header": ({ children }: LayoutProps) => (
    <div className="min-h-0 flex-1 p-4">{children}</div>
  ),
  "workspace-table": ({ children }: LayoutProps) => (
    <div className="flex min-h-0 flex-1 flex-col p-4">{children}</div>
  ),
} as const satisfies Record<VisualLayout, ComponentType<LayoutProps>>;

export const Route = createFileRoute("/dev")({
  validateSearch: visualSearchSchema,
  component: DevRouteComponent,
});

function DevRouteComponent() {
  const visual = Route.useSearch({ select: (search) => search.visual }) ?? "ui";
  return (
    <main className="bg-background flex min-h-0 flex-1 flex-col overflow-y-auto">
      <VisualPlayground
        layout={visualLayouts[visualRegistry[visual].layout]}
        visual={visual}
      />
    </main>
  );
}
