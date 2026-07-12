import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";

type ContactPickerOrganizationKey = {
  organizationId: string;
};

type ContactPickerSearchKey = ContactPickerOrganizationKey & {
  q: string;
  type?: "person" | "organization" | undefined;
};

export const contactPickerKeys = {
  all: ["contact-picker"] as const,
  byOrganization: ({ organizationId }: ContactPickerOrganizationKey) => [
    ...contactPickerKeys.all,
    organizationId,
  ],
  search: ({ organizationId, q, type }: ContactPickerSearchKey) => [
    ...contactPickerKeys.byOrganization({ organizationId }),
    "search",
    { q, type },
  ],
};

type ContactPickerSearchOptionsInput =
  QueryOptionsInput<ContactPickerSearchKey>;

export const contactPickerSearchOptions = ({
  organizationId,
  q,
  type,
}: ContactPickerSearchOptionsInput) =>
  queryOptions({
    queryKey: contactPickerKeys.search({ organizationId, q, type }),
    queryFn: async ({ signal }) => {
      const response = await api.contacts.search.get({
        query: { q, ...(type !== undefined && { type }) },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data.items;
    },
  });
