import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";

type OrganizationAnonymizationBlacklistKey = {
  organizationId: string;
};

export const organizationAnonymizationBlacklistKeys = {
  all: ["organization-settings", "anonymization-blacklist"] as const,
  byOrganization: ({
    organizationId,
  }: OrganizationAnonymizationBlacklistKey) => [
    ...organizationAnonymizationBlacklistKeys.all,
    organizationId,
  ],
};

type OrganizationAnonymizationBlacklistOptionsInput =
  QueryOptionsInput<OrganizationAnonymizationBlacklistKey>;

export const organizationAnonymizationBlacklistOptions = ({
  organizationId,
}: OrganizationAnonymizationBlacklistOptionsInput) =>
  queryOptions({
    queryKey: organizationAnonymizationBlacklistKeys.byOrganization({
      organizationId,
    }),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"][
        "anonymization-blacklist"
      ].get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
