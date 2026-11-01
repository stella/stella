import { hashKey } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { rootKeys, sessionOptions } from "@/lib/auth-query-options";
import {
  closeSessionExpiredNotice,
  setSessionMemberSeen,
} from "@/lib/errors/session-expired";

/**
 * Tracks the session read: a member's session clears the notice. Apart from
 * the notice itself so `user-toast`, which shared views import, stays free of
 * the auth client.
 */
export const installSessionExpiredNotice = (queryClient: QueryClient) => {
  const sessionHash = hashKey(rootKeys.session);
  const hasMember = () =>
    queryClient.getQueryData(sessionOptions.queryKey)?.user !== undefined;
  setSessionMemberSeen(hasMember());
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash !== sessionHash || !hasMember()) {
      return;
    }
    setSessionMemberSeen(true);
    if (event.type === "updated" && event.action.type === "success") {
      closeSessionExpiredNotice();
    }
  });
};
