import { useQuery } from "@tanstack/react-query";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/** True only after the organization turns matter numbers on in settings. */
export const useMatterNumberingEnabled = () => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const settingsQuery = useQuery(
    organizationSettingsOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  const settingsView = queryView(settingsQuery);
  useQueryViewError(settingsView, "useMatterNumberingEnabled:query");
  return (
    settingsView.type === "items" && settingsView.items.matterNumberingEnabled
  );
};
