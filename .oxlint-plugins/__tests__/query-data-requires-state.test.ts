import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (source: string) =>
  await lintSingleRule(
    "query-data-requires-state",
    `import { useQuery, useQuery as read, useInfiniteQuery, useQueries, useSuspenseQuery } from "@tanstack/react-query";
import * as rq from "@tanstack/react-query";
import { useChromeQuery as chrome } from "@/hooks/use-chrome-query"; import {useMemo, useMemo as memo} from "react"; import * as React from "react";
${source}`,
    { ruleOptions: { census: true }, sourcePath: "apps/web/src/source.tsx" },
  );

describe.serial("query data state", () => {
  test("reports data reads, aliases, defaults and query collections", async () => {
    expect(
      await lint(`
function List() { const { data } = useQuery(q); return data?.length ? <List/> : <Empty/>; }
function Rows() { const { data: rows = [] } = read(q); return rows; }
function Infinite() { const query = useInfiniteQuery(q); return query.data ?? []; }
function Namespace() { const query = rq.useQuery(q); return !query.data; }
function Chrome() { const { data } = chrome(q); return data === undefined; }
function Collection() { const queries = useQueries(q); return queries.map(query => query.data); }
function Element() { const queries = useQueries(q); return queries.at(0)?.data; }
function Destructure() { const [{ data }] = useQueries(q); return data; }
function Alias() { const query = useQuery(q); const other = query; const { data } = other; return data; }
`),
    ).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  test("contact picker search requires query state before defaulting results", async () => {
    expect(
      await lint(`
const ContactPicker = () => {
  const { data: results = [] } = useQuery({
    ...contactPickerSearchOptions({ organizationId, q: debouncedQuery, type }),
    enabled: debouncedQuery.length > 0,
  });
  return results.map(contact => <Option contact={contact} />);
};
`),
    ).toEqual([6]);
  });

  test("spinner and retry counters cannot distinguish an initial error from empty data", async () => {
    expect(
      await lint(`
function Spinner(){const query=useQuery(q); if(query.fetchStatus === "fetching")return <Spinner/>; return query.data ?? [];}
function Counter(){const {data,failureCount}=useQuery(q); display(failureCount); return data ?? [];}
function ForwardCounter(){const {data,failureCount}=useQuery(q); return {data,failureCount};}
`),
    ).toEqual([5, 6, 7]);
  });

  test("accepts state handling, complete results, suspense and unrelated names", async () => {
    expect(
      await lint(`
function List() { const { data, isError } = useQuery(q); if (isError) return <Error/>; return data?.length ? <List/> : <Empty/>; }
function View() { const query = useQuery(q); return useQueryView(query); }
function Forward() { const query = useQuery(q); display(query); return query.data; }
function Suspense() { const { data } = useSuspenseQuery(q); return data; }
function State() { const query = useQuery(q); if (query.status === "error") return null; return query.data; }
function Collection() { const queries = useQueries(q); return queries.map(({ data, error }) => error ? null : data); }
function Unrelated(useQuery) { const { data } = useQuery(q); return data; }
function useFull() { const query = useQuery(q); return query; }
function useFields() { const { data, error } = useQuery(q); return { data, error }; }
`),
    ).toEqual([]);
  });

  test("reports hooks that erase errors from derived values", async () => {
    expect(
      await lint(`
function useIsRunning(){ const { data } = useQuery(q); return data ?? false; }
function useCount(){ const { data, error } = useQuery(q); observe(error); const count = data?.length ?? 0; return count; }
const useMemoRows = () => { const query = useQuery(q); if (query.isError) observe(query.error); return useMemo(() => query.data ?? [], [query.data]); };
function useLoading(){ const { data, isPending } = useQuery(q); return { data, isPending }; }
`),
    ).toEqual([5, 6, 7, 8]);
  });

  test("requires a state read rather than an unused state binding", async () => {
    expect(
      await lint(
        `function List(){ const { data, error } = useQuery(q); return data ?? []; }`,
      ),
    ).toEqual([4]);
  });

  test("tracks nested data patterns, result rests and collection iteration", async () => {
    expect(
      await lint(`
function NestedArray(){ const { data: [row] } = useQuery(q); return row; }
function NestedObject(){ const { data: { rows } } = useQuery(q); return rows; }
function Rest(){ const { error, ...rest } = useQuery(q); return rest.data ?? []; }
function Iteration(){ const queries = useQueries(q); for(const {data} of queries) display(data); }
function Write(){ const query = useQuery(q); query.error = null; return query.data; }
function useMixed(){ const { data, error } = useQuery(q); if(error) return {data,error}; return data; }
function useConditional(){ const { data, error } = useQuery(q); return error ? [] : data; }
function useRest(){ const { data, ...rest } = useQuery(q); return {data,...rest}; }
`),
    ).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  test("tracks query combine projections and static computed properties", async () => {
    expect(
      await lint(`
function Combine(){ const results = useQueries({queries, combine: results => results.map(r => r.data)}); return results; }
function useCombined(){ const combine = useCallback(results => results.map(({data}) => data), []); const data = useQueries({queries, combine}); return data; }
function Computed(){ const query = useQuery(q); return query["data"]; }
function Dynamic(){ const query = useQuery(q); return query[data]; }
function Handled(){ const query = useQuery(q); if (query["error"]) return null; return query["data"]; }
function FakeState(){ const query = useQuery(q); observe(query[error]); return query.data; }
`),
    ).toEqual([5, 6, 7, 10]);
  });

  test("accepts explicit error unions, thrown errors and results carried by containers", async () => {
    expect(
      await lint(`
function useState(){const {data,error}=useQuery(q); if(error)return {type:"error",error}; return {type:"items",items:data};}
function useThrown(){const query=useQuery(q); if(query.error)throw query.error; return query.data;}
function Passed(){const query=useQuery(q); return <View query={query} data={query.data}/>;}
function Collected(){const query=useQuery(q); const queries=[query]; handle(queries); return query.data;}
`),
    ).toEqual([]);
  });

  test("memo projections preserve returned state rather than dependency reads", async () => {
    expect(
      await lint(`
function useFields(){const query=useQuery(q);return useMemo(()=>({data:query.data,error:query.error}),[query.data,query.error]);}
function useAlias(){const query=useQuery(q);return memo(()=>({data:query.data,error:query.error}),[query.data,query.error]);}
function useNamespace(){const query=useQuery(q);return React.useMemo(()=>{return {data:query.data,error:query.error};},[query.data,query.error]);}
function useStripped(){const query=useQuery(q);return useMemo(()=>query.data,[query.data,query.error]);}
`),
    ).toEqual([8]);
  });
});
