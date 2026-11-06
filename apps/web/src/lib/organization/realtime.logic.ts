import type { QueryKey } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import type { OrganizationRealtimeEvent } from "@stll/api-contract";

import { contactsQueryRoot } from "@/lib/resource-query-roots.logic";

/**
 * The organization-wide queries an organization event refreshes in every tab,
 * whatever page it shows. A matter's own views refresh through that matter's
 * stream instead; a resource type with no organization-wide view refreshes
 * nothing here.
 */
export const organizationEventQueryKeys = (
  event: OrganizationRealtimeEvent,
  organizationId: string,
): QueryKey[] => {
  if (event.resourceType === RESOURCE_TYPE.CONTACT) {
    // Every list, page and picker of this organization's address book.
    return [[...contactsQueryRoot(), organizationId]];
  }
  return [];
};
