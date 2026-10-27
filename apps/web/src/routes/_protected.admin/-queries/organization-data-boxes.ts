import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";
import { organizationSettingsQueryRoot } from "@/lib/resource-query-roots.logic";

type OrganizationDataBoxesKey = {
  organizationId: string;
};

export const organizationDataBoxesKeys = {
  all: [
    ...organizationSettingsQueryRoot(),
    "correspondence-data-boxes",
  ] as const,
  byOrganization: ({ organizationId }: OrganizationDataBoxesKey) => [
    ...organizationDataBoxesKeys.all,
    organizationId,
  ],
};

export const organizationDataBoxesOptions = ({
  organizationId,
}: QueryOptionsInput<OrganizationDataBoxesKey>) =>
  queryOptions({
    queryKey: organizationDataBoxesKeys.byOrganization({ organizationId }),
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api["organization-settings"].correspondence["data-boxes"].get({
          fetch: { signal },
        }),
      ),
  });
