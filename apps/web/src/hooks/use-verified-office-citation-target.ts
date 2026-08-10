import { useQuery } from "@tanstack/react-query";

import type { OfficeCitationLocator } from "@stll/api-contract";

import { shouldRetryAPIRequest } from "@/lib/errors/api";
import {
  isVerifiedOfficeCitationTarget,
  parseOfficeCitationHref,
  type OfficeCitationSource,
  type OfficeCitationTarget,
} from "@/lib/files/office-citations";
import { officeCitationOptions } from "@/lib/files/queries";

export type VerifiedOfficeCitationTarget =
  | {
      type: "error";
      retry: () => Promise<unknown>;
      target: OfficeCitationTarget;
    }
  | {
      type: "unverified";
      target: OfficeCitationTarget;
      verify: () => Promise<{
        locator: OfficeCitationLocator;
        source: OfficeCitationSource;
      } | null>;
    };

export const useVerifiedOfficeCitationTarget = (
  href: string,
  workspaceId: string | undefined,
): VerifiedOfficeCitationTarget | null => {
  const target = parseOfficeCitationHref(href);
  const citationQuery = useQuery({
    ...officeCitationOptions({
      blockId: target?.blockId ?? "",
      entityId: target?.entityId ?? "",
      fieldId: target?.fieldId ?? "",
      workspaceId: workspaceId ?? "",
    }),
    enabled: false,
    gcTime: 0,
    staleTime: 0,
  });

  if (!target || !workspaceId) {
    return null;
  }
  if (citationQuery.isError && !citationQuery.data) {
    if (!shouldRetryAPIRequest(0, citationQuery.error)) {
      return null;
    }
    return { retry: citationQuery.refetch, target, type: "error" };
  }
  return {
    target,
    type: "unverified",
    verify: async () => {
      const result = await citationQuery.refetch();
      if (
        !result.data ||
        !isVerifiedOfficeCitationTarget({
          source: result.data.source,
          target,
        })
      ) {
        return null;
      }
      return result.data;
    },
  };
};
