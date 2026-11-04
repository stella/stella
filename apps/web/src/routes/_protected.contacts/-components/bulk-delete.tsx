import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { CONTACT_BULK_DELETE_LIMIT } from "@stll/api-contract";
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

/**
 * What the deletion is for. Undoing an import deletes the contacts that
 * import created, so its button, confirmation and receipt say so instead of
 * reusing the wording for an arbitrary selection.
 */
type BulkDeletePurpose = "selection" | "import-undo";

const useBulkDeleteCopy = (purpose: BulkDeletePurpose) => {
  const t = useTranslations();
  const copies = {
    selection: {
      action: (count: number) => t("contacts.deleteSelected", { count }),
      title: (count: number) => t("contacts.deleteSelected", { count }),
      confirm: (count: number) =>
        t("contacts.deleteSelectedConfirm", { count }),
      done: (count: number) => t("contacts.deletedCount", { count }),
    },
    "import-undo": {
      action: (count: number) =>
        t("contacts.importStudio.undoImport", { count: String(count) }),
      title: () => t("contacts.importStudio.undoImportTitle"),
      confirm: (count: number) =>
        t("contacts.importStudio.undoImportConfirm", { count }),
      done: (count: number) =>
        t("contacts.importStudio.undoneToast", { count }),
    },
  } satisfies Record<BulkDeletePurpose, unknown>;
  return copies[purpose];
};

export function BulkDeleteContacts({
  contactIds,
  deleteContacts = requestBulkDelete,
  organizationId,
  onResolved,
  purpose = "selection",
}: {
  contactIds: readonly string[];
  deleteContacts?: DeleteContacts | undefined;
  organizationId: string;
  onResolved: (resolvedIds: readonly string[]) => void;
  purpose?: BulkDeletePurpose;
}) {
  const t = useTranslations();
  const copy = useBulkDeleteCopy(purpose);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const exceedsLimit = contactIds.length > CONTACT_BULK_DELETE_LIMIT;

  const handleDelete = async () => {
    if (exceedsLimit) {
      return;
    }
    setPending(true);
    const outcomes = await deleteContacts(contactIds);
    const deletedIds = outcomes.flatMap((outcome) =>
      outcome.status === "deleted" ? [outcome.contactId] : [],
    );
    // A contact the server no longer has may still be cached from before
    // another session deleted it; only a blocked one still exists.
    const resolvedIds = outcomes.flatMap((outcome) =>
      outcome.status === "blocked" ? [] : [outcome.contactId],
    );
    for (const contactId of resolvedIds) {
      queryClient.removeQueries({
        queryKey: contactsKeys.byId(organizationId, contactId),
      });
    }
    await queryClient.invalidateQueries({
      queryKey: contactsKeys.lists(organizationId),
    });
    setPending(false);
    setOpen(false);
    onResolved(resolvedIds);
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
      title: copy.done(deletedIds.length),
      type: "success",
    });
  };

  if (contactIds.length === 0) {
    return null;
  }

  return (
    <>
      <div>
        <Button
          disabled={exceedsLimit}
          onClick={() => setOpen(true)}
          size="sm"
          variant="destructive"
        >
          <Trash2Icon />
          {copy.action(contactIds.length)}
        </Button>
        {exceedsLimit ? (
          <p className="text-muted-foreground mt-1 text-xs">
            {t("contacts.deleteSelectedLimit", {
              limit: String(CONTACT_BULK_DELETE_LIMIT),
            })}
          </p>
        ) : null}
      </div>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title(contactIds.length)}</AlertDialogTitle>
            <AlertDialogDescription>
              {copy.confirm(contactIds.length)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={exceedsLimit}
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

/**
 * Undo for a finished import. Stateless on purpose: the results step owns
 * which created contacts the undo removed, so its summary and list can never
 * disagree with this button.
 */
export function ImportUndoContacts({
  contactIds,
  deleteContacts,
  onUndone,
  organizationId,
}: {
  /** The contacts this import created that still exist. */
  contactIds: readonly string[];
  deleteContacts?: DeleteContacts | undefined;
  onUndone: (removedIds: readonly string[]) => void;
  organizationId: string;
}) {
  return (
    <BulkDeleteContacts
      contactIds={contactIds}
      deleteContacts={deleteContacts}
      onResolved={onUndone}
      organizationId={organizationId}
      purpose="import-undo"
    />
  );
}
