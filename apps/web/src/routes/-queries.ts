import { queryOptions } from "@tanstack/react-query";

import { authClient } from "@/lib/auth";
import { STALE_TIME } from "@/lib/consts";
import { toAuthClientError } from "@/lib/errors";

export const rootKeys = {
  session: ["session"],
  role: ["role"],
};

export const sessionOptions = queryOptions({
  staleTime: STALE_TIME.FIVE.MINUTES,
  gcTime: STALE_TIME.FIVE.MINUTES,
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
  staleTime: STALE_TIME.INFINITE,
  queryKey: rootKeys.role,
  queryFn: async () => {
    const result = await authClient.organization.getActiveMemberRole();

    if (result.error) {
      throw toAuthClientError(result.error);
    }

    return result.data.role;
  },
});
