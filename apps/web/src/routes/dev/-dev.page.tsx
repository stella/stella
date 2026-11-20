import type { ComponentType, ReactElement } from "react";

import { getRouteApi } from "@tanstack/react-router";

import {
  resolveVisualName,
  visualRegistry,
} from "@/routes/dev/-visual-metadata";
import type { VisualLayout } from "@/routes/dev/-visual-metadata";

import { DevShell } from "./-dev.pending";
import { VisualPlayground } from "./-visual-registry";

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

const routeApi = getRouteApi("/dev");

export function DevPage() {
  const visual = routeApi.useSearch({
    select: (search) => resolveVisualName(search.visual),
  });
  return (
    <DevShell visual={visual}>
      <VisualPlayground
        layout={visualLayouts[visualRegistry[visual].layout]}
        visual={visual}
      />
    </DevShell>
  );
}
