import { Result } from "better-result";

import { useUpdateContact } from "@/lib/contacts/mutations";
import type {
  ContactData,
  ContactPatch,
} from "@/routes/_protected.contacts/-components/types";

export const useContactPatch = (contact: ContactData) => {
  const updateContact = useUpdateContact();

  const saveContactPatch = (patch: ContactPatch, onError?: () => void) => {
    updateContact.mutate(
      {
        organizationId: contact.organizationId,
        contactId: contact.id,
        ...patch,
      },
      {
        onError: () => onError?.(),
      },
    );
  };

  const saveContactPatchAsync = async (patch: ContactPatch) => {
    const result = await Result.tryPromise({
      try: async () =>
        await updateContact.mutateAsync({
          organizationId: contact.organizationId,
          contactId: contact.id,
          ...patch,
        }),
      catch: (error) => error,
    });
    if (Result.isError(result)) {
      return false;
    }
    return true;
  };

  return {
    isPending: updateContact.isPending,
    saveContactPatch,
    saveContactPatchAsync,
  };
};
