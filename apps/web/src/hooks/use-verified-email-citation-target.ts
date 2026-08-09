import { skipToken, useQuery } from "@tanstack/react-query";

import {
  isVerifiedEmailCitationTarget,
  parseEmailCitationHref,
  useKnownEmailCitationTarget,
  type EmailCitationTarget,
} from "@/lib/files/email-citations";
import { emailHtmlPreviewOptions } from "@/lib/files/queries";
import { isFileDisplayable, type WorkspaceFieldContent } from "@/lib/types";
import { entityOptions } from "@/lib/workspaces/queries/entities";

export type VerifiedEmailCitationEntity = {
  fields: {
    content: WorkspaceFieldContent;
    id: string;
    propertyId: string;
  }[];
  name: string | null;
};

export type VerifiedEmailCitationTarget =
  | { type: "active"; target: EmailCitationTarget }
  | {
      type: "verified";
      entity: VerifiedEmailCitationEntity;
      target: EmailCitationTarget;
    };

export const useVerifiedEmailCitationTarget = (
  href: string,
  workspaceId: string | undefined,
): VerifiedEmailCitationTarget | null => {
  const target = parseEmailCitationHref(href);
  const knownTarget = useKnownEmailCitationTarget(href);
  const shouldVerify = Boolean(target && workspaceId && !knownTarget);
  const entityQuery = useQuery({
    ...(shouldVerify && target && workspaceId
      ? entityOptions(workspaceId, target.entityId)
      : {
          queryKey: ["email-citation-entity-disabled", href] as const,
          queryFn: skipToken,
        }),
    enabled: shouldVerify,
    staleTime: Number.POSITIVE_INFINITY,
  });
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
  if (!target || !entityQuery.data || !previewQuery.data) {
    return null;
  }

  const sourceFieldIds = entityQuery.data.fields.flatMap((field) =>
    field.content.type === "file" && isFileDisplayable(field.content)
      ? [field.id]
      : [],
  );
  if (
    !isVerifiedEmailCitationTarget({
      blockIds: previewQuery.data.citationBlocks.map(({ id }) => id),
      sourceFieldIds,
      target,
    })
  ) {
    return null;
  }

  return { entity: entityQuery.data, target, type: "verified" };
};
