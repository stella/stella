// Passive regression fixture for require-router-select.

declare const useParams: (options?: unknown) => unknown;
declare const useSearch: (options?: unknown) => unknown;
declare const Route: { useRouteContext: (options?: unknown) => unknown };
declare const options: unknown;

export const useFixtureSelections = () => {
  // oxlint-disable-next-line require-router-select/require-router-select -- fixture: argument-free hook subscribes to the whole object
  const allParams = useParams();
  // oxlint-disable-next-line require-router-select/require-router-select -- fixture: opaque options cannot prove a select
  const opaqueSearch = useSearch(options);
  // oxlint-disable-next-line require-router-select/require-router-select -- fixture: route-scoped hook also requires select
  const wholeContext = Route.useRouteContext({});

  const selectedParam = useParams({ select: (value: unknown) => value });
  const selectedSearch = useSearch({ select: (value: unknown) => value });
  return {
    allParams,
    opaqueSearch,
    selectedParam,
    selectedSearch,
    wholeContext,
  };
};
