import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useIsMobile } from "@stll/ui/use-mobile";

import {
  createStatuteLinkTab,
  type StatuteLink,
} from "@/components/chat/chat-app-link.logic";
import { openPublicLawLink } from "@/components/chat/public-law-open";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import {
  publicStatuteOptions,
  statuteBySlugOptions,
} from "@/features/statutes/queries/statutes";
import { resolveStatuteRoute } from "@/features/statutes/statute-route-resolution";
import { createStatuteLinkTarget } from "@/lib/statute-route";

/**
 * Open the statute a chat link names, the way a cited act opens: an inspector
 * tab beside the chat, the act's own page on a phone, where there is no
 * beside. The link resolves as the act's page resolves it, so a `/v/` day
 * nothing was in force on opens the act, as the page redirects to it. Both
 * the tab and the page land on the link's provision anchor.
 */
export const useOpenStatuteLink = () => {
  const queryClient = useQueryClient();
  const { open: openView } = useInspectorView();
  const navigate = useNavigate();
  const inspectorAvailable = !useIsMobile();

  const resolveLink = async ({ params }: StatuteLink) => {
    const resolution = await resolveStatuteRoute(
      { ...params, asOf: undefined },
      {
        byId: async (documentId) =>
          await queryClient.query(publicStatuteOptions(documentId)),
        bySlug: async (key) =>
          await queryClient.query(statuteBySlugOptions(key)),
      },
    );
    return resolution.type === "found"
      ? (resolution.statute ?? resolution.work)
      : null;
  };

  return async (link: StatuteLink) =>
    await openPublicLawLink({
      resolve: async () => await resolveLink(link),
      open: async (statute) => {
        if (inspectorAvailable) {
          openView(createStatuteLinkTab(statute, link));
          return;
        }

        await navigate({
          ...createStatuteLinkTarget({
            country: statute.country,
            documentId: statute.id,
            eli: statute.eli,
            slug: statute.slug,
            versionValidFrom: statute.versionValidFrom,
          }),
          ...(link.anchor === null ? {} : { hash: link.anchor }),
        });
      },
    });
};
