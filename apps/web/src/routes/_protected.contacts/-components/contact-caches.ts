import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useUpdateContact } from "@/lib/contacts/mutations";
import type {
  ContactData,
  ContactPatch,
} from "@/routes/_protected.contacts/-components/types";

export const useContactPatch = (contact: ContactData) => {
  const t = useTranslations();
  const updateContact = useUpdateContact();
  const handleError = (onError?: () => void) => {
    stellaToast.add({
      title: t("errors.actionFailed"),
      type: "error",
    });
    onError?.();
  };

  const saveContactPatch = (patch: ContactPatch, onError?: () => void) => {
    updateContact.mutate(
      {
        organizationId: contact.organizationId,
        contactId: contact.id,
        ...patch,
      },
      {
        onError: () => handleError(onError),
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
      handleError();
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
