import { hashKey } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { browserStorage } from "@/lib/account/browser-storage";
import { assignUserStorage } from "@/lib/account/user-scoped-storage";
import { rootKeys } from "@/lib/auth-queries";
import { signedInUserId } from "@/lib/session-cache-guard";

const SESSION_QUERY_HASH = hashKey(rootKeys.session);
const browserAreas = () => ({
  local: browserStorage("local"),
  session: browserStorage("session"),
});

/** Session reads supply ownership to browser persistence. */
export const installUserScopedStorage = (
  queryClient: QueryClient,
  areas = browserAreas,
) =>
  queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.query.queryHash !== SESSION_QUERY_HASH
    ) {
      return;
    }
    assignUserStorage(signedInUserId(event.query.state.data), areas());
  });
