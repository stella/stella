import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

export const sellerProfilesKeys = {
  all: (organizationId: string) => ["seller-profiles", organizationId] as const,
};

const listSellerProfiles = async (
  cursor: string | undefined,
  signal: AbortSignal,
) =>
  unwrapEden(
    await api["seller-profiles"].get({
      query: { ...(cursor === undefined ? {} : { cursor }) },
      fetch: { signal },
    }),
  );

export const sellerProfilesOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: sellerProfilesKeys.all(organizationId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      listSellerProfiles(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const sellerProfileOptions = ({
  organizationId,
  id,
}: {
  organizationId: string;
  id: string;
}) =>
  queryOptions({
    queryKey: [...sellerProfilesKeys.all(organizationId), "profile", id],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["seller-profiles"]({
          sellerProfileId: toSafeId<"sellerProfile">(id),
        }).get({ fetch: { signal } }),
      ),
  });
