import { useQuery } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingChromeEnabled } from "@/hooks/use-time-billing-preview";
import { roleOptions } from "@/lib/auth-queries";

/** The time surfaces in the chrome; a role still loading keeps them in place. */
export const useTimeChromeVisible = (): boolean => {
  const enabled = useTimeBillingChromeEnabled();
  const canRead = usePermissions({ timeEntry: ["read"] });
  const rolePending = useQuery(roleOptions).isPending;
  return enabled && (canRead || rolePending);
};
