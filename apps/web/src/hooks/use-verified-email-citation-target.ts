import { useQuery } from "@tanstack/react-query";

import { shouldRetryAPIRequest } from "@/lib/errors/api";
import {
  isVerifiedEmailCitationTarget,
  parseEmailCitationHref,
  useKnownEmailCitationTarget,
  type EmailCitationSource,
  type EmailCitationTarget,
} from "@/lib/files/email-citations";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";

export type VerifiedEmailCitationTarget =
  | { type: "active"; target: EmailCitationTarget }
  | {
      type: "error";
      retry: () => Promise<unknown>;
      target: EmailCitationTarget;
    }
  | {
      type: "verified";
      source: EmailCitationSource;
      target: EmailCitationTarget;
    }
  | {
      type: "unverified";
      target: EmailCitationTarget;
      verify: () => Promise<EmailCitationSource | null>;
    };

export const useVerifiedEmailCitationTarget = (
  href: string,
  workspaceId: string | undefined,
): VerifiedEmailCitationTarget | null => {
  const target = parseEmailCitationHref(href);
  const knownTarget = useKnownEmailCitationTarget(href);
  const previewQuery = useQuery({
    ...emailHtmlPreviewOptions({
      fieldId: target?.fieldId ?? "",
      workspaceId: workspaceId ?? "",
    }),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (knownTarget) {
    return { type: "active", target: knownTarget };
  }
  if (!target) {
    return null;
  }
  if (!workspaceId) {
    return null;
  }
  if (previewQuery.isError && !previewQuery.data) {
    if (!shouldRetryAPIRequest(0, previewQuery.error)) {
      return null;
    }
    return { retry: previewQuery.refetch, target, type: "error" };
  }
  if (!previewQuery.data) {
    return {
      target,
      type: "unverified",
      verify: async () => {
        const result = await previewQuery.refetch();
        if (
          !result.data ||
          !isVerifiedEmailCitationTarget({
            blockIds: result.data.citationBlocks.map(({ id }) => id),
            source: result.data.source,
            target,
          })
        ) {
          return null;
        }
        return result.data.source;
      },
    };
  }

  if (
    !isVerifiedEmailCitationTarget({
      blockIds: previewQuery.data.citationBlocks.map(({ id }) => id),
      source: previewQuery.data.source,
      target,
    })
  ) {
    return null;
  }

  return { source: previewQuery.data.source, target, type: "verified" };
};
