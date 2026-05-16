import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import type {
  ContactData,
  ContactPatch,
} from "@/routes/_protected.contacts/-components/types";
import { useUpdateContact } from "@/routes/_protected.contacts/-mutations";
import { contactsKeys } from "@/routes/_protected.contacts/-queries";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type InvalidateContactCachesOptions = {
  invalidateWorkspaces?: boolean;
};

export const invalidateContactCaches = async (
  queryClient: QueryClient,
  contactId: string,
  { invalidateWorkspaces = false }: InvalidateContactCachesOptions = {},
) => {
  const promises = [
    queryClient.invalidateQueries({
      queryKey: contactsKeys.byId(contactId),
    }),
    queryClient.invalidateQueries({
      queryKey: contactsKeys.lists(),
    }),
  ];

  if (invalidateWorkspaces) {
    promises.push(
      queryClient.invalidateQueries({
        queryKey: workspacesKeys.all,
      }),
    );
  }

  await Promise.all(promises);
};

export const useContactPatch = (contact: ContactData) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();

  const handleSuccess = () => {
    void invalidateContactCaches(queryClient, contact.id);
  };

  const handleError = (onError?: () => void) => {
    stellaToast.add({
      title: t("errors.actionFailed"),
      type: "error",
    });
    onError?.();
  };

  const saveContactPatch = (patch: ContactPatch, onError?: () => void) => {
    updateContact.mutate(
      { contactId: contact.id, ...patch },
      {
        onSuccess: handleSuccess,
        onError: () => handleError(onError),
      },
    );
  };

  const saveContactPatchAsync = async (patch: ContactPatch) => {
    try {
      await updateContact.mutateAsync({ contactId: contact.id, ...patch });
      await invalidateContactCaches(queryClient, contact.id);
      return true;
    } catch {
      handleError();
      return false;
    }
  };

  return {
    isPending: updateContact.isPending,
    saveContactPatch,
    saveContactPatchAsync,
  };
};
