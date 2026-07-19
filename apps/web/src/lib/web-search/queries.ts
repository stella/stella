import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";

type WebSearchKeysKey = {
  organizationId: string;
};

export const webSearchKeysKeys = {
  all: ["organization-web-search-keys"] as const,
  config: ({ organizationId }: WebSearchKeysKey) => [
    ...webSearchKeysKeys.all,
    "config",
    organizationId,
  ],
};

type WebSearchConfigOptionsInput = QueryOptionsInput<WebSearchKeysKey>;

export const webSearchConfigOptions = ({
  organizationId,
}: WebSearchConfigOptionsInput) =>
  queryOptions({
    queryKey: webSearchKeysKeys.config({ organizationId }),
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"][
        "web-search-config"
      ].get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });
