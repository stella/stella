import type { QueryFunctionContext } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import type { FeatureAccessPrincipal } from "@/queries/feature-access.logic";

const fetchFeatureAccess = async ({ signal }: QueryFunctionContext) =>
  unwrapEden(
    await api["organization-settings"]["feature-access"].get({
      fetch: { signal },
    }),
  );

export const featureAccessOptions = ({
  organizationId,
  userId,
}: FeatureAccessPrincipal) =>
  queryOptions({
    queryKey: ["feature-access", organizationId, userId] as const,
    queryFn: fetchFeatureAccess,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type FeatureAccessState = Awaited<ReturnType<typeof fetchFeatureAccess>>;
