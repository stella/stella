import * as React from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";

const UiPlayground = import.meta.env.DEV
  ? React.lazy(async () => {
      const module = await import("@/routes/dev/-components/ui-playground");

      return { default: module.UiPlayground };
    })
  : null;

export const Route = createFileRoute("/dev")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/" });
    }
  },
  component: DevRouteComponent,
});

function DevRouteComponent() {
  if (UiPlayground === null) {
    return null;
  }

  return (
    <React.Suspense fallback={null}>
      <UiPlayground />
    </React.Suspense>
  );
}
