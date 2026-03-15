import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";

export const organizationKeys = {
  all: ["organization", "full"],
};

export const organizationOptions = queryOptions({
  queryKey: organizationKeys.all,
  queryFn: async () => {
    const result = await authClient.organization.getFullOrganization();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
});
