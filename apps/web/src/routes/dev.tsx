import type { ComponentType, ReactElement } from "react";

import { createFileRoute } from "@tanstack/react-router";

import {
  VisualPlayground,
  visualRegistry,
  visualSearchSchema,
} from "@/routes/dev/-visual-registry";
import type { VisualLayout } from "@/routes/dev/-visual-registry";

type LayoutProps = { children: ReactElement };

const visualLayouts = {
  plain: ({ children }: LayoutProps) => children,
  "control-sizes": ({ children }: LayoutProps) => (
    <main className="bg-background min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-5 py-5 lg:grid-cols-2">{children}</div>
      </div>
    </main>
  ),
  "inspector-pane": ({ children }: LayoutProps) => (
    <main className="bg-background flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {children}
    </main>
  ),
  "workspace-table": ({ children }: LayoutProps) => (
    <main className="bg-background flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      {children}
    </main>
  ),
} as const satisfies Record<VisualLayout, ComponentType<LayoutProps>>;

export const Route = createFileRoute("/dev")({
  validateSearch: visualSearchSchema,
  component: DevRouteComponent,
});

function DevRouteComponent() {
  const visual = Route.useSearch({ select: (search) => search.visual }) ?? "ui";
  return (
    <VisualPlayground
      layout={visualLayouts[visualRegistry[visual].layout]}
      visual={visual}
    />
  );
}
