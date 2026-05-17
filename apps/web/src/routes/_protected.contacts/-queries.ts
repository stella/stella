import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";

type ContactsListKey = {
  type?: "person" | "organization" | undefined;
  q?: string | undefined;
};

export const contactsKeys = {
  all: ["contacts"],
  lists: () => [...contactsKeys.all, "list"],
  list: (key?: ContactsListKey) => [
    ...contactsKeys.lists(),
    key ? { type: key.type, q: key.q } : undefined,
  ],
  byId: (contactId: string) => [...contactsKeys.all, contactId],
};

export const contactsOptions = (filters?: {
  type?: "person" | "organization" | undefined;
  q?: string | undefined;
}) =>
  queryOptions({
    queryKey: contactsKeys.list(filters),
    queryFn: async ({ signal }) => {
      const response = await api.contacts.get({
        query: {
          limit: 50,
          ...(filters?.type !== undefined && {
            type: filters.type,
          }),
          ...(filters?.q !== undefined && { q: filters.q }),
        },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
  });

export const contactOptions = (contactId: string) =>
  queryOptions({
    queryKey: contactsKeys.byId(contactId),
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
