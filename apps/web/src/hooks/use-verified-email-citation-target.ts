import { skipToken, useQuery } from "@tanstack/react-query";

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
    ...(shouldVerify && target && workspaceId
      ? emailHtmlPreviewOptions({ fieldId: target.fieldId, workspaceId })
      : {
          queryKey: ["email-citation-preview-disabled", href] as const,
          queryFn: skipToken,
        }),
    enabled: shouldVerify,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (knownTarget) {
    return { type: "active", target: knownTarget };
  }
  if (!target || !previewQuery.data) {
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
