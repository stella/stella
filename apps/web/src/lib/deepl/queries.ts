import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";

const DEEPL_AVAILABILITY_STALE_MS = 5 * 60 * 1000;

type DeepLAvailabilityKey = {
  organizationId: string;
};

export const deepLKeys = {
  all: ["organization-deepl"] as const,
  availability: ({ organizationId }: DeepLAvailabilityKey) => [
    ...deepLKeys.all,
    "availability",
    organizationId,
  ],
  config: ({ organizationId }: DeepLAvailabilityKey) => [
    ...deepLKeys.all,
    "config",
    organizationId,
  ],
};

type DeepLAvailabilityOptionsInput = QueryOptionsInput<DeepLAvailabilityKey>;

export const deepLAvailabilityOptions = ({
  organizationId,
}: DeepLAvailabilityOptionsInput) =>
  queryOptions({
    queryKey: deepLKeys.availability({ organizationId }),
    staleTime: DEEPL_AVAILABILITY_STALE_MS,
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"].deepl.get({
        fetch: { signal },
      });

      return unwrapEden(response);
    },
  });

export const deepLConfigOptions = ({
  organizationId,
}: DeepLAvailabilityOptionsInput) =>
  queryOptions({
    queryKey: deepLKeys.config({ organizationId }),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"]["deepl-config"].get({
        fetch: { signal },
      });

      return unwrapEden(response);
    },
  });
