import { infiniteQueryOptions } from "@tanstack/react-query";

import type { CorrespondenceDropReason } from "@stll/api-contract/correspondence";

import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

import { correspondenceKeys } from "./correspondence";

type CorrespondenceDropsResponse = Awaited<
  ReturnType<
    ReturnType<typeof api.workspaces>["correspondence"]["drops"]["get"]
  >
>;
export type CorrespondenceDropsPage = NonNullable<
  CorrespondenceDropsResponse["data"]
>;
export type CorrespondenceDrop = CorrespondenceDropsPage["items"][number];

export const CORRESPONDENCE_DROP_REASON_LABELS = {
  unknown_recipient: "correspondence.drops.reasons.unknownRecipient",
  revoked_address: "correspondence.drops.reasons.revokedAddress",
  unauthorized_sender: "correspondence.drops.reasons.unauthorizedSender",
  authentication_failed: "correspondence.drops.reasons.authenticationFailed",
  message_too_large: "correspondence.drops.reasons.messageTooLarge",
  attachment_rejected: "correspondence.drops.reasons.attachmentRejected",
  malformed_message: "correspondence.drops.reasons.malformedMessage",
} as const satisfies Record<CorrespondenceDropReason, TranslationKey>;

export const CORRESPONDENCE_DROP_HINT_LABELS = {
  configure_sender_spf_dkim_dmarc: "correspondence.drops.authenticationHint",
} as const satisfies Record<
  NonNullable<CorrespondenceDrop["setupHint"]>,
  TranslationKey
>;

const DROP_PAGE_SIZE = 25;

export const correspondenceDropsOptions = (workspaceId: string) =>
  infiniteQueryOptions({
    queryKey: [
      ...correspondenceKeys.all(workspaceId),
      "drops",
      { limit: DROP_PAGE_SIZE },
    ],
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api
        .workspaces({ workspaceId })
        .correspondence.drops.get({
          query: {
            limit: DROP_PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
          fetch: { signal },
        });
      return unwrapEden(response);
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
