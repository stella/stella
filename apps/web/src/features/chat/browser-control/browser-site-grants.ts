import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Result } from "better-result";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { api } from "@/lib/api";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { useQueryViewError } from "@/lib/use-query-view";

type BrowserSiteGrantsKey = {
  activeOrganizationId: string;
  userId: string;
};

/**
 * The websites the user lets chat's browser actions run on without asking,
 * as the API stores them. A card reads them fresh before it answers itself,
 * so a site removed on another device never answers a new card.
 */
export const browserSiteGrantsOptions = ({
  activeOrganizationId,
  userId,
}: BrowserSiteGrantsKey) =>
  queryOptions({
    queryKey: chatKeys.browserSiteGrants(activeOrganizationId, userId),
    queryFn: async ({ signal }) => {
      const response = await api.chat["browser-site-grants"].get({
        fetch: { signal },
      });
      return unwrapApiResponse(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

export type BrowserSiteGrantsResponse = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof browserSiteGrantsOptions>["queryFn"]>
  >
>;

export type BrowserSiteGrant = BrowserSiteGrantsResponse["grants"][number];

/** The granted origins, for the approval policy; empty until they load. */
export const grantedBrowserOrigins = (
  grants: readonly BrowserSiteGrant[] | undefined,
): ReadonlySet<string> => new Set(grants?.map(({ origin }) => origin));

/** The origins the API holds grants for now, read past the cache. */
export const readGrantedBrowserOrigins = async ({
  key,
  queryClient,
}: {
  key: BrowserSiteGrantsKey;
  queryClient: QueryClient;
}): Promise<ReadonlySet<string>> => {
  const fresh = await queryClient.fetchQuery({
    ...browserSiteGrantsOptions(key),
    staleTime: 0,
  });
  return grantedBrowserOrigins(fresh.grants);
};

/**
 * The signed-in user's website approvals for a browser card: the cached set
 * that decides whether the card may answer itself, and a fresh read it
 * answers on. Without a signed-in user there are none, and the fresh read is
 * null.
 */
export const useBrowserSiteGrants = (enabled: boolean) => {
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const key =
    user === null
      ? null
      : { activeOrganizationId: user.activeOrganizationId, userId: user.id };
  const grantsQuery = useQuery({
    ...browserSiteGrantsOptions(
      key ?? {
        activeOrganizationId: SIGNED_OUT_QUERY_OWNER,
        userId: SIGNED_OUT_QUERY_OWNER,
      },
    ),
    enabled: enabled && key !== null,
  });
  const grantsView = queryView(grantsQuery);
  useQueryViewError(grantsView, "useBrowserSiteGrants:query");
  return {
    canGrant: key !== null,
    grantedOrigins: grantedBrowserOrigins(
      grantsView.type === "items" ? grantsView.items.grants : undefined,
    ),
    /** The sites allowed now, read past the cache; null when it failed. */
    readFresh: async (): Promise<ReadonlySet<string> | null> => {
      if (key === null) {
        return null;
      }
      const fresh = await Result.tryPromise(
        async () => await readGrantedBrowserOrigins({ key, queryClient }),
      );
      return fresh.isOk() ? fresh.value : null;
    },
    /** Stores a website approval and refreshes every reader of the list. */
    allow: async (origin: string) => {
      await storeBrowserSiteGrant(origin);
      if (key !== null) {
        await queryClient.invalidateQueries({
          queryKey: chatKeys.browserSiteGrants(
            key.activeOrganizationId,
            key.userId,
          ),
        });
      }
    },
  };
};

/** Stores a grant for the site `url` is on; the API keeps only its origin. */
export const storeBrowserSiteGrant = async (url: string) =>
  unwrapApiResponse(await api.chat["browser-site-grants"].post({ url }));

export const deleteBrowserSiteGrant = async (grantId: string) =>
  unwrapApiResponse(
    await api.chat["browser-site-grants"]({
      grantId: toSafeId<"chatBrowserSiteGrant">(grantId),
    }).delete(),
  );
