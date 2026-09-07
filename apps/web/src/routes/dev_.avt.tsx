import * as React from "react";

import { createFileRoute, Navigate } from "@tanstack/react-router";
import { panic } from "better-result";

const AVT_APP_MODULE_PATH = "/src/routes/dev_.avt/-components/avt/avt-app.tsx";

type AvtAppModule = { AvtApp: React.ComponentType };

const isAvtAppModule = (module: unknown): module is AvtAppModule =>
  typeof module === "object" &&
  module !== null &&
  "AvtApp" in module &&
  typeof module.AvtApp === "function";

const AvtApp = import.meta.env.DEV
  ? React.lazy(async () => {
      // Keep the dev harness outside the production dependency graph.
      const module: unknown = await import(
        /* @vite-ignore */ AVT_APP_MODULE_PATH
      );
      if (!isAvtAppModule(module)) {
        return panic("AVT dev harness module does not export AvtApp");
      }

      return { default: module.AvtApp };
    })
  : null;

export const Route = createFileRoute("/dev_/avt")({
  component: AvtRouteComponent,
});

function AvtRouteComponent() {
  if (AvtApp === null) {
    return <Navigate replace to="/" />;
  }

  return (
    <React.Suspense fallback={null}>
      <AvtApp />
    </React.Suspense>
  );
}
