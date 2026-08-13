import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";

import type { RouteErrorLifecycleController } from "@/lib/analytics/route-error-lifecycle";

export const RouteErrorLifecycleProvider = ({
  children,
  controller,
}: PropsWithChildren<{ controller: RouteErrorLifecycleController }>) => (
  <RouteErrorLifecycleContext value={controller}>
    {children}
  </RouteErrorLifecycleContext>
);

const RouteErrorLifecycleContext =
  createContext<RouteErrorLifecycleController | null>(null);

export const useRouteErrorLifecycle = (): RouteErrorLifecycleController => {
  const controller = use(RouteErrorLifecycleContext);
  if (controller === null) {
    return panic("Route error lifecycle context is unavailable");
  }
  return controller;
};
