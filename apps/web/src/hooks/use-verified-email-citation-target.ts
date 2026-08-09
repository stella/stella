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
    };

export const useVerifiedEmailCitationTarget = (
  href: string,
  workspaceId: string | undefined,
): VerifiedEmailCitationTarget | null => {
  const target = parseEmailCitationHref(href);
  const knownTarget = useKnownEmailCitationTarget(href);
  const shouldVerify = Boolean(target && workspaceId && !knownTarget);
  const previewQuery = useQuery({
    ...emailHtmlPreviewOptions({
      fieldId: target?.fieldId ?? "",
      workspaceId: workspaceId ?? "",
    }),
    enabled: shouldVerify,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (knownTarget) {
    return { type: "active", target: knownTarget };
  }
  if (!target) {
    return null;
  }
  if (previewQuery.isError && !previewQuery.data) {
    if (!shouldRetryAPIRequest(0, previewQuery.error)) {
      return null;
    }
    return { retry: previewQuery.refetch, target, type: "error" };
  }
  if (!previewQuery.data) {
    return null;
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
