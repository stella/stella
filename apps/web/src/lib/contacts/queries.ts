import { queryOptions } from "@tanstack/react-query";

import type { ContactType } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { contactsQueryRoot } from "@/lib/resource-query-roots.logic";

type ContactsListKey = {
  type?: ContactType | undefined;
  q?: string | undefined;
};

export const contactsKeys = {
  all: contactsQueryRoot(),
  scoped: (activeOrganizationId: string) => [
    ...contactsKeys.all,
    activeOrganizationId,
  ],
  lists: (activeOrganizationId: string) => [
    ...contactsKeys.scoped(activeOrganizationId),
    "list",
  ],
  list: (activeOrganizationId: string, { type, q }: ContactsListKey) => [
    ...contactsKeys.lists(activeOrganizationId),
    { type, q },
  ],
  byId: (activeOrganizationId: string, contactId: string) => [
    ...contactsKeys.scoped(activeOrganizationId),
    contactId,
  ],
};

export const contactsOptions = (
  activeOrganizationId: string,
  filters: ContactsListKey = {},
) =>
  queryOptions({
    queryKey: contactsKeys.list(activeOrganizationId, filters),
    queryFn: async ({ signal }) => {
      const response = await api.contacts.get({
        query: {
          limit: 50,
          ...(filters.type !== undefined && { type: filters.type }),
          ...(filters.q !== undefined && { q: filters.q }),
        },
        fetch: { signal },
      });

      return unwrapEden(response);
    },
  });

export const contactOptions = (
  activeOrganizationId: string,
  contactId: string,
) =>
  queryOptions({
    queryKey: contactsKeys.byId(activeOrganizationId, contactId),
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
    queryFn: async ({ signal }) => {
      const response = await api
        .contacts({ contactId })
        .get({ fetch: { signal } });

      return unwrapEden(response);
    },
  });
