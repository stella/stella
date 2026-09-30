import type { QueryClient } from "@tanstack/react-query";

import { signalSessionChange } from "@/lib/account/session-signal";
import { rootKeys } from "@/lib/auth-query-options";
import { settleAuthTransition } from "@/lib/session-cache-guard";

export {
  rootKeys,
  roleOptions,
  sessionOptions,
} from "@/lib/auth-query-options";

/** Refreshes authentication queries; the host finishes frame cleanup after unmount. */
export const refreshAuthQueries = async (queryClient: QueryClient) => {
  await Promise.all([
    queryClient.refetchQueries({ queryKey: rootKeys.session, type: "all" }),
    queryClient.refetchQueries({ queryKey: rootKeys.role, type: "all" }),
  ]);
  await settleAuthTransition(queryClient);
  signalSessionChange();
};
