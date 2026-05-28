import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import type { QueryOptionsInput } from "@/lib/react-query";

type DeepLAvailabilityKey = {
  organizationId: string;
};

export const deepLKeys = {
  all: ["organization-deepl"] as const,
  availability: ({ organizationId }: DeepLAvailabilityKey) => [
    ...deepLKeys.all,
    organizationId,
  ],
};

type DeepLAvailabilityOptionsInput = QueryOptionsInput<DeepLAvailabilityKey>;

export const deepLAvailabilityOptions = ({
  organizationId,
}: DeepLAvailabilityOptionsInput) =>
  queryOptions({
    queryKey: deepLKeys.availability({ organizationId }),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"].deepl.get({
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
