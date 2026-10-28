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

type AssertRouteNotFoundCensusOptions = {
  routes: readonly RouteNotFoundCensusEntry[];
  resourcePaths: ReadonlySet<string>;
  exemptions: readonly RouteParamExemption[];
  routerSource: string;
};

/** Enforces the route-level half of the shared not-found contract. */
export const assertRouteNotFoundCensus = ({
  routes,
  resourcePaths,
  exemptions,
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

  for (const route of routes) {
    if (route.hasChildren && route.source.includes("notFoundComponent:")) {
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
