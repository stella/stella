import { queryOptions } from "@tanstack/react-query";

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
    // Links change only when someone pins or unpins one, and both mutations
    // invalidate this key; re-reading the whole set every time the tab regains
    // focus would spend a request on the matter's hot path for nothing.
    refetchOnWindowFocus: false,
  });

export type MatterDecisionLink = Awaited<
  ReturnType<NonNullable<ReturnType<typeof matterLinksOptions>["queryFn"]>>
>[number];

type LinkDecisionsInput = {
  workspaceId: string;
  decisionIds: readonly string[];
  /** What the reader wrote about why these decisions belong to the matter. */
  note: string | null;
};

/**
 * Pin decisions into a matter, in one request.
 *
 * One request rather than one per decision, because a save is one action: a
 * request per decision fails in the middle, leaving links the caller never
 * hears about and a reader who is told nothing was saved. The endpoint answers
 * with the three outcomes instead — newly linked, already linked, and refused
 * with a reason — so the toast can report what actually happened.
 */
export const linkDecisionsToMatter = async ({
  decisionIds,
  note,
  workspaceId,
}: LinkDecisionsInput) =>
  unwrapEden(
    await matterLinksApi(workspaceId).batch.post({
      items: decisionIds.map((decisionId) => ({
        decisionId: toSafeId<"caseLawDecision">(decisionId),
        note,
      })),
    }),
  );

export type MatterLinkBatchResult = Awaited<
  ReturnType<typeof linkDecisionsToMatter>
>;

/** Why one decision of a batch was refused; the toast names each reason. */
export type MatterLinkRejectionReason =
  MatterLinkBatchResult["rejected"][number]["reason"];

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
