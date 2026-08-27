import * as React from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

const DEV_VISUAL = {
  controlSizes: "control-sizes",
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

const searchSchema = v.object({
  visual: v.optional(v.literal(DEV_VISUAL.controlSizes)),
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

  if (UiPlayground === null) {
    return null;
  }

  return (
    <React.Suspense fallback={null}>
      <UiPlayground />
    </React.Suspense>
  );
}
