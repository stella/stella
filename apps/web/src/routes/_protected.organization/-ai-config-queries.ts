import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";

export const aiConfigKeys = {
  all: ["organization-ai-config"] as const,
  availabilityRoot: ["organization-ai-availability"] as const,
  byOrganization: ({ organizationId }: OrganizationAIConfigKey) => [
    ...aiConfigKeys.all,
    organizationId,
  ],
  availability: ({ organizationId }: OrganizationAIConfigKey) => [
    ...aiConfigKeys.availabilityRoot,
    organizationId,
  ],
};

type OrganizationAIConfigKey = {
  organizationId: string;
};

type AIConfigOptionsInput = QueryOptionsInput<OrganizationAIConfigKey>;
type AIAvailabilityOptionsInput = QueryOptionsInput<OrganizationAIConfigKey>;

export const aiConfigOptions = ({ organizationId }: AIConfigOptionsInput) =>
  queryOptions({
    queryKey: aiConfigKeys.byOrganization({ organizationId }),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"]["ai-config"].get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

/**
 * AI availability for any org member, regardless of admin
 * permissions on the full AI config. Returns just the booleans
 * needed by the gate; ai-config is admin-only.
 */
export const aiAvailabilityOptions = ({
  organizationId,
}: AIAvailabilityOptionsInput) =>
  queryOptions({
    queryKey: aiConfigKeys.availability({ organizationId }),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"][
        "ai-availability"
      ].get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
