import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

declare const options: {
  queryKey: readonly unknown[];
  queryFn: () => string[];
};
declare const List: () => React.ReactNode;
declare const Empty: () => React.ReactNode;
declare const Failure: () => React.ReactNode;
declare const useQueryView: (query: ReturnType<typeof useQuery>) => unknown;

export const DataList = () => {
  // oxlint-disable-next-line query-data-requires-state/query-data-requires-state
  const { data } = useQuery(options);
  return data?.length ? <List /> : <Empty />;
};

export const DefaultRows = () => {
  // oxlint-disable-next-line query-data-requires-state/query-data-requires-state
  const { data: rows = [] } = useQuery(options);
  return rows;
};

export const useIsRunning = () => {
  // oxlint-disable-next-line query-data-requires-state/query-data-requires-state
  const { data } = useQuery(options);
  return data ?? false;
};

export const HandledList = () => {
  // expect-clean: query-data-requires-state/query-data-requires-state
  const { data, isError } = useQuery(options);
  if (isError) {
    return <Failure />;
  }
  return data?.length ? <List /> : <Empty />;
};

export const View = () => {
  const query = useQuery(options);
  return useQueryView(query);
};

export const Suspense = () => {
  const { data } = useSuspenseQuery(options);
  return data;
};

export const SpinnerOnly = () => {
  // oxlint-disable-next-line query-data-requires-state/query-data-requires-state
  const query = useQuery(options);
  if (query.fetchStatus === "fetching") {
    return <List />;
  }
  return query.data ?? [];
};

export const FailureCounterOnly = () => {
  // oxlint-disable-next-line query-data-requires-state/query-data-requires-state
  const { data, failureCount } = useQuery(options);
  return { data, failureCount };
};
