import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

type ContactsListKey = {
  type?: "person" | "organization" | undefined;
  q?: string | undefined;
};

export const contactsKeys = {
  all: ["contacts"],
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

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const contactOptions = (
  activeOrganizationId: string,
  contactId: string,
) =>
  queryOptions({
    queryKey: contactsKeys.byId(activeOrganizationId, contactId),
    queryFn: async ({ signal }) => {
      const response = await api
        .contacts({ contactId })
        .get({ fetch: { signal } });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });
