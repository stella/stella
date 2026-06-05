import * as React from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";

const AutocompletePlayground = import.meta.env.DEV
  ? React.lazy(async () => {
      const module =
        await import("@/routes/dev/-components/autocomplete-playground");
      return { default: module.AutocompletePlayground };
    })
  : null;

export const Route = createFileRoute("/_protected/dev_/autocomplete")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/" });
    }
  },
  component: AutocompleteRouteComponent,
});

function AutocompleteRouteComponent() {
  if (AutocompletePlayground === null) {
    return null;
  }
  return (
    <React.Suspense fallback={null}>
      <AutocompletePlayground />
    </React.Suspense>
  );
}
