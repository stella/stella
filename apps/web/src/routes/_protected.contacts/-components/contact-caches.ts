import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useUpdateContact } from "@/lib/contacts/mutations";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { workspacesKeys } from "@/lib/workspaces/queries";
import type {
  ContactData,
  ContactPatch,
} from "@/routes/_protected.contacts/-components/types";

const protectedRouteApi = getRouteApi("/_protected");

type InvalidateContactCachesArgs = {
  activeOrganizationId: string;
  contactId: string;
  invalidateWorkspaces?: boolean;
};

export const invalidateContactCaches = async (
  queryClient: QueryClient,
  {
    activeOrganizationId,
    contactId,
    invalidateWorkspaces = false,
  }: InvalidateContactCachesArgs,
) => {
  const promises = [
    queryClient.invalidateQueries({
      queryKey: contactsKeys.byId(activeOrganizationId, contactId),
    }),
    queryClient.invalidateQueries({
      queryKey: contactsKeys.lists(activeOrganizationId),
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
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const handleSuccess = () => {
    detached(
      invalidateContactCaches(queryClient, {
        activeOrganizationId,
        contactId: contact.id,
      }),
      "handleSuccess",
    );
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
      await invalidateContactCaches(queryClient, {
        activeOrganizationId,
        contactId: contact.id,
      });
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
