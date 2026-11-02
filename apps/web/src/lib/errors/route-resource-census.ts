import { panic } from "better-result";

export type RouteNotFoundCensusEntry = {
  file: string;
  path: string;
  source: string;
  hasChildren: boolean;
};

export type RouteParamExemption = {
  path: string;
  reason: string;
};

/** A child-bearing layout that keeps its own not-found answer, and why. */
export type LayoutNotFoundExemption = {
  path: string;
  reason: string;
};

type AssertRouteNotFoundCensusOptions = {
  routes: readonly RouteNotFoundCensusEntry[];
  resourcePaths: ReadonlySet<string>;
  exemptions: readonly RouteParamExemption[];
  layoutExemptions: readonly LayoutNotFoundExemption[];
  routerSource: string;
};

/** Enforces the route-level half of the shared not-found contract. */
export const assertRouteNotFoundCensus = ({
  routes,
  resourcePaths,
  exemptions,
  layoutExemptions,
  routerSource,
}: AssertRouteNotFoundCensusOptions): void => {
  if (
    !routerSource.includes("defaultNotFoundComponent: DefaultNotFoundComponent")
  ) {
    panic("The router must install the shared default not-found component");
  }

  const exemptPaths = new Set(exemptions.map(({ path }) => path));
  for (const { path, reason } of exemptions) {
    if (reason.trim() === "") {
      panic(`The route exemption ${path} must include a reason`);
    }
  }

  const exemptLayouts = new Set(layoutExemptions.map(({ path }) => path));
  for (const { path, reason } of layoutExemptions) {
    if (reason.trim() === "") {
      panic(`The layout exemption ${path} must include a reason`);
    }
    const layout = routes.find((route) => route.path === path);
    if (
      layout === undefined ||
      !layout.hasChildren ||
      !layout.source.includes("notFoundComponent:")
    ) {
      panic(
        `The layout exemption ${path} no longer names a layout with its own not-found component`,
      );
    }
  }

  for (const route of routes) {
    if (
      route.hasChildren &&
      route.source.includes("notFoundComponent:") &&
      !exemptLayouts.has(route.path)
    ) {
      panic(
        `${route.file} has children and must inherit the shared not-found component`,
      );
    }

    const hasParam = route.path.split("/").some((part) => part.startsWith("$"));
    if (!hasParam) {
      continue;
    }
    if (resourcePaths.has(route.path)) {
      if (!route.source.includes("loadRouteResource")) {
        panic(`${route.file} must load resources through loadRouteResource`);
      }
      continue;
    }
    if (!exemptPaths.has(route.path)) {
      panic(`${route.file} has an unclassified route parameter`);
    }
  }
};
