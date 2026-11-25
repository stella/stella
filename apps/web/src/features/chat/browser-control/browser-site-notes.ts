import { queryOptions } from "@tanstack/react-query";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { STALE_TIME } from "@/lib/consts";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

type BrowserSiteNotesKey = {
  activeOrganizationId: string;
  userId: string;
};

/**
 * The research notes chat's agent keeps about how the member's websites
 * work, by website, as the API stores them. The agent writes them while it
 * browses; the member reads and removes them in Settings.
 */
export const browserSiteNotesOptions = ({
  activeOrganizationId,
  userId,
}: BrowserSiteNotesKey) =>
  queryOptions({
    queryKey: chatKeys.browserSiteNotes(activeOrganizationId, userId),
    queryFn: async ({ signal }) => {
      const response = await api.chat["browser-site-notes"].get({
        fetch: { signal },
      });
      return unwrapApiResponse(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });

type BrowserSiteNotesResponse = Awaited<
  ReturnType<NonNullable<ReturnType<typeof browserSiteNotesOptions>["queryFn"]>>
>;

export type NotedBrowserSite = BrowserSiteNotesResponse["sites"][number];

export type BrowserSiteNote = NotedBrowserSite["notes"][number];

/** Removes one note; only the member does, from Settings. */
export const deleteBrowserSiteNote = async (noteId: string) =>
  await invokeAppOnlyWrite("chat.browser-site-notes.delete", async () =>
    unwrapApiResponse(
      await api.chat["browser-site-notes"]({
        noteId: toSafeId<"chatBrowserSiteNote">(noteId),
      }).delete(),
    ),
  );

/** Removes every note kept for one website. */
export const deleteBrowserSiteNotesForSite = async (origin: string) =>
  await invokeAppOnlyWrite("chat.browser-site-notes.sites.delete", async () =>
    unwrapApiResponse(
      await api.chat["browser-site-notes"].sites.delete(undefined, {
        query: { url: origin },
      }),
    ),
  );
