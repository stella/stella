import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { Trash2Icon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";

type BulkDeleteOutcome = {
  contactId: string;
  status: "blocked" | "deleted" | "not_found";
};

type DeleteContacts = (
  contactIds: readonly string[],
) => Promise<readonly BulkDeleteOutcome[]>;

const requestBulkDelete = async (
  contactIds: readonly string[],
): Promise<readonly BulkDeleteOutcome[]> =>
  await invokeCapability(
    "contacts.bulk.delete",
    async (request) =>
      unwrapApiResponse(
        await api.contacts.delete({ contactIds: [...contactIds] }, request),
      ).outcomes,
  );

export function BulkDeleteContacts({
  contactIds,
  deleteContacts = requestBulkDelete,
  organizationId,
  onDeleted,
  labelKey = "contacts.deleteSelected",
}: {
  contactIds: readonly string[];
  deleteContacts?: DeleteContacts | undefined;
  organizationId: string;
  onDeleted: (deletedIds: readonly string[]) => void;
  labelKey?: "contacts.deleteSelected" | "contacts.importStudio.undoImport";
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const handleDelete = async () => {
    setPending(true);
    const outcomes = await deleteContacts(contactIds);
    const deletedIds = outcomes.flatMap((outcome) =>
      outcome.status === "deleted" ? [outcome.contactId] : [],
    );
    for (const contactId of deletedIds) {
      queryClient.removeQueries({
        queryKey: contactsKeys.byId(organizationId, contactId),
      });
    }
    await queryClient.invalidateQueries({
      queryKey: contactsKeys.lists(organizationId),
    });
    setPending(false);
    setOpen(false);
    onDeleted(deletedIds);
    const blockedCount = outcomes.filter(
      ({ status }) => status === "blocked",
    ).length;
    const notFoundCount = outcomes.filter(
      ({ status }) => status === "not_found",
    ).length;
    if (blockedCount > 0 || notFoundCount > 0) {
      stellaToast.add({
        description: [
          blockedCount > 0 ? t("contacts.deleteBlockedByMattersCount") : null,
          notFoundCount > 0
            ? t("contacts.deleteNotFoundCount", {
                count: String(notFoundCount),
              })
            : null,
        ]
          .filter((message) => message !== null)
          .join(" "),
        title: t("contacts.deleteBlockedCount", {
          count: String(blockedCount + notFoundCount),
        }),
        type: "warning",
      });
      return;
    }
    stellaToast.add({
      title: t("contacts.deletedCount", { count: deletedIds.length }),
      type: "success",
    });
  };

  if (contactIds.length === 0) {
    return null;
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="destructive">
        <Trash2Icon />
        {labelKey === "contacts.deleteSelected"
          ? t("contacts.deleteSelected", { count: contactIds.length })
          : t("contacts.importStudio.undoImport", {
              count: String(contactIds.length),
            })}
      </Button>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("contacts.deleteSelected", { count: contactIds.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("contacts.deleteSelectedConfirm", {
                count: contactIds.length,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              loading={pending}
              onClick={() => {
                detached(
                  handleDelete().catch((error: unknown) => {
                    setPending(false);
                    notifyUserError(error, t("errors.actionFailed"));
                  }),
                  "contacts.bulk-delete",
                );
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function ImportUndoContacts({
  contactIds,
  deleteContacts,
  organizationId,
}: {
  contactIds: readonly string[];
  deleteContacts?: DeleteContacts | undefined;
  organizationId: string;
}) {
  const [remainingIds, setRemainingIds] = useState(contactIds);

  return (
    <BulkDeleteContacts
      contactIds={remainingIds}
      deleteContacts={deleteContacts}
      labelKey="contacts.importStudio.undoImport"
      onDeleted={(deletedIds) =>
        setRemainingIds((currentIds) =>
          currentIds.filter((contactId) => !deletedIds.includes(contactId)),
        )
      }
      organizationId={organizationId}
    />
  );
}
