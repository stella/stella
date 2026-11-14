import { createContext, use } from "react";
import type { Context, PropsWithChildren } from "react";

import { useRouterState } from "@tanstack/react-router";
import { panic } from "better-result";

import type { AppFrameScope, ProviderScope } from "@/routes/-app-frame-scope";
import type { RoutePresentation } from "@/routes/-route-presentation";

declare module "@tanstack/react-router" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- router static data uses declaration merging
  interface StaticDataRouteOption {
    appFrame?: AppFrameScope;
    providerScopes?: readonly ProviderScope[];
    organizationSettingsAdmission?: "time-billing";
    presentation?: RoutePresentation;
  }
}

type RouteProviderScope = {
  routeId: string;
  scopes: readonly ProviderScope[];
};

const RouteProviderScopeContext = createContext<RouteProviderScope | null>(
  null,
);

/** Scopes permit local hosts; the required hook also checks the actual provider. */
export const RouteProviderScopeBoundary = ({ children }: PropsWithChildren) => {
  const scope = useRouterState({
    select: ({ matches }) => ({
      routeId: matches.at(-1)?.routeId ?? "__root__",
      scopes: [
        ...new Set(
          matches.flatMap(({ staticData }) => staticData.providerScopes ?? []),
        ),
      ],
    }),
    structuralSharing: true,
  });
  return (
    <RouteProviderScopeContext value={scope}>
      {children}
    </RouteProviderScopeContext>
  );
};

type RequiredRouteProviderOptions<T> = {
  context: Context<T>;
  scope: ProviderScope;
  missingMessage: string;
};

export const useRequiredRouteProvider = <T,>({
  context,
  scope,
  missingMessage,
}: RequiredRouteProviderOptions<T>) => {
  const value = use(context);
  const route = use(RouteProviderScopeContext);
  if (route && !route.scopes.includes(scope)) {
    panic(
      `Route ${route.routeId} is missing declared provider scope: ${scope}`,
    );
  }
  if (value === null || value === undefined) {
    panic(
      route
        ? `Route ${route.routeId} is missing provider scope: ${scope}. ${missingMessage}`
        : missingMessage,
    );
  }
  return value;
};
