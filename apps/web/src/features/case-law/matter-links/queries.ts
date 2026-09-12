import { queryOptions } from "@tanstack/react-query";

import { mapWithConcurrency } from "@stll/concurrency";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * The decisions a matter keeps: the one place case law and a client
 * engagement meet. A link is the pair, plus the note whoever pinned it left.
 */

type MatterLinksKey = { workspaceId: string };

export const matterLinkKeys = {
  all: ["case-law", "matter-links"],
  list: ({ workspaceId }: MatterLinksKey) => [
    ...matterLinkKeys.all,
    "list",
    { workspaceId },
  ],
};

const matterLinksApi = (workspaceId: string) =>
  api.case["matter-links"]({ workspaceId: toSafeId<"workspace">(workspaceId) });

/** Every decision linked to the matter, newest link first; the cap bounds it. */
export const matterLinksOptions = (key: MatterLinksKey) =>
  queryOptions({
    queryKey: matterLinkKeys.list(key),
    queryFn: async ({ signal }) =>
      unwrapEden(
        await matterLinksApi(key.workspaceId).get({ fetch: { signal } }),
      ).links,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export type MatterDecisionLink = Awaited<
  ReturnType<NonNullable<ReturnType<typeof matterLinksOptions>["queryFn"]>>
>[number];

/** How many links are created at once; the rest wait rather than flood. */
const LINK_CONCURRENCY = 4;

type LinkDecisionsInput = {
  workspaceId: string;
  decisionIds: readonly string[];
  /** What the reader wrote about why these decisions belong to the matter. */
  note: string | null;
};

/**
 * Pin decisions into a matter, a few requests at a time.
 *
 * A decision already linked comes back as its existing link, so re-pinning is
 * a no-op rather than an error the reader has to read: the count reported is
 * what the matter holds from this action, not how many rows were new.
 */
export const linkDecisionsToMatter = async ({
  decisionIds,
  note,
  workspaceId,
}: LinkDecisionsInput) =>
  await mapWithConcurrency({
    items: decisionIds,
    limit: LINK_CONCURRENCY,
    operation: async (decisionId) =>
      unwrapEden(
        await matterLinksApi(workspaceId).post({
          decisionId: toSafeId<"caseLawDecision">(decisionId),
          note,
        }),
      ),
  });

export const unlinkDecisionFromMatter = async ({
  linkId,
  workspaceId,
}: {
  linkId: string;
  workspaceId: string;
}) =>
  unwrapEden(
    await matterLinksApi(workspaceId)({
      linkId: toSafeId<"caseLawMatterLink">(linkId),
    }).delete(),
  );
