import type { QueryClient } from "@tanstack/react-query";

import { signalSessionChange } from "@/lib/account/session-signal";
import { rootKeys } from "@/lib/auth-query-options";

export {
  rootKeys,
  sessionOptions,
  roleOptions,
} from "@/lib/auth-query-options";

/** Refreshes authentication queries; the host finishes frame cleanup after unmount. */
export const refreshAuthQueries = async (queryClient: QueryClient) => {
  // Load the reset owner at the call boundary; it reads these query options.
  const { settleAuthTransition } = await import("@/lib/session-cache-guard");
  await Promise.all([
    queryClient.refetchQueries({ queryKey: rootKeys.session, type: "all" }),
    queryClient.refetchQueries({ queryKey: rootKeys.role, type: "all" }),
  ]);
  await settleAuthTransition(queryClient);
  signalSessionChange();
};
