import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";

export const rootKeys = {
  session: ["session"],
  role: ["role"],
};

export const sessionOptions = queryOptions({
  queryKey: rootKeys.session,
  queryFn: async () => {
    const result = await authClient.getSession();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data;
  },
});

export const roleOptions = queryOptions({
  queryKey: rootKeys.role,
  queryFn: async () => {
    const result = await authClient.organization.getActiveMemberRole();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data.role;
  },
});
