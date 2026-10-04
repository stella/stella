import type { UseQueryResult } from "@tanstack/react-query";

import { queryView } from "@/lib/query-view.logic";
import type { QueryView, QueryViewOptions } from "@/lib/query-view.logic";

export const useQueryView = <TData, TError>(
  query: UseQueryResult<TData, TError>,
  options?: QueryViewOptions<TData>,
): QueryView<TData, TError> => queryView(query, options);
