import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { STALE_TIME } from "@/lib/consts";
import { toAuthClientError } from "@/lib/errors";

export const organizationKeys = {
  all: ["organization", "full"],
};

export const organizationOptions = queryOptions({
  staleTime: STALE_TIME.FIVE.MINUTES,
  queryKey: organizationKeys.all,
  queryFn: async () => {
    const result = await authClient.organization.getFullOrganization();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
});
