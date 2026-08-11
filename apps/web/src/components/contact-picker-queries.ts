import { queryOptions } from "@tanstack/react-query";

import type { ContactType } from "@stll/api-contract";

import { api } from "@/lib/api";
import { contactsKeys } from "@/lib/contacts/queries";
import { unwrapEden } from "@/lib/errors/api";
import type { QueryOptionsInput } from "@/lib/react-query";

type ContactPickerOrganizationKey = {
  organizationId: string;
};

type ContactPickerSearchKey = ContactPickerOrganizationKey & {
  q: string;
  type?: ContactType | undefined;
};

// The picker serves a filtered view of the org's contacts, so it hangs under
// the contacts list prefix rather than a root of its own: every contact
// invalidation (`contactsKeys.all`, `contactsKeys.lists`, and the realtime
// CONTACTS scope) then prefix-matches it. A private root would keep serving
// pre-edit results for the whole stale window because nothing invalidates it.
export const contactPickerKeys = {
  byOrganization: ({ organizationId }: ContactPickerOrganizationKey) => [
    ...contactsKeys.lists(organizationId),
    "picker",
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

      return unwrapEden(response).items;
    },
  });
