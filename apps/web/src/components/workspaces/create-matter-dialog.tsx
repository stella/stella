import { useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import type { ContactType } from "@stll/api-contract";
import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldLabel } from "@stll/ui/field";
import { BuildingIcon, UserIcon, XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { ContactPicker } from "@/components/contact-picker";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { getPossibleDuplicateMatters } from "@/components/workspaces/create-matter-dialog.logic";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useCreateContact } from "@/lib/contacts/mutations";
import { contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { createUuid } from "@/lib/uuid";
import type { MatterDraftClient } from "@/lib/workspaces/create-matter-store";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { useCreateWorkspace } from "@/lib/workspaces/mutations";
import { workspacesOptions } from "@/lib/workspaces/queries";

export const SelectedClient = ({
  client,
  onClear,
  clearLabel,
}: {
  client: MatterDraftClient;
  onClear: () => void;
  clearLabel: string;
}) => (
  <div className="bg-muted/40 flex items-center gap-2 rounded-lg border px-3 py-2">
    {client.type === "person" ? (
      <UserIcon className="text-muted-foreground size-4" />
    ) : (
      <BuildingIcon className="text-muted-foreground size-4" />
    )}
    <BidiText as="span" className="truncate text-sm font-medium">
      {client.displayName}
    </BidiText>
    <Button
      aria-label={clearLabel}
      className="ms-auto"
      onClick={onClear}
      size="icon-xs"
      variant="ghost"
    >
      <XIcon className="size-3.5" />
    </Button>
  </div>
);

const toActionErrorTitle = ({
  error,
  fallback,
}: {
  error: unknown;
  fallback: string;
}) => userErrorFromThrown(error, fallback);

export const CreateMatterDialog = () => {
  const { closeDialog, dialog } = useCreateMatterStore(
    useShallow((s) => ({
      closeDialog: s.closeDialog,
      dialog: s.dialog,
    })),
  );
  const isOpen = dialog.status === "open";
  const draftClient = dialog.status === "open" ? dialog.draftClient : null;
  const onCreated = dialog.status === "open" ? dialog.onCreated : undefined;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          closeDialog();
        }
      }}
      open={isOpen}
    >
      {isOpen ? (
        <CreateMatterDialogBody
          closeDialog={closeDialog}
          draftClient={draftClient}
          key={draftClient?.id ?? "new"}
          {...(onCreated === undefined ? {} : { onCreated })}
        />
      ) : null}
    </Dialog>
  );
};

type CreateMatterDialogBodyProps = {
  closeDialog: () => void;
  draftClient: MatterDraftClient | null;
  onCreated?: (workspaceId: string) => void | Promise<void>;
};

const CreateMatterDialogBody = ({
  closeDialog,
  draftClient,
  onCreated,
}: CreateMatterDialogBodyProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const currentUser = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const createWorkspace = useCreateWorkspace();
  const createContact = useCreateContact();
  const [name, setName] = useState("");
  const [selectedClient, setSelectedClient] =
    useState<MatterDraftClient | null>(draftClient);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const workspacesDataQuery = useChromeQuery({
    ...workspacesOptions(currentUser.activeOrganizationId),
  });
  const workspacesDataView = useQueryView(workspacesDataQuery);
  useQueryViewError(workspacesDataView, "CreateMatterDialogBody:query");
  const workspacesData =
    workspacesDataView.type === "items" ? workspacesDataView.items : undefined;

  const handleClose = () => {
    closeDialog();
  };

  const handleCreateClient = async (displayName: string, type: ContactType) => {
    const id = toSafeId<"contact">(createUuid());

    const result = await Result.tryPromise(
      async () =>
        await createContact.mutateAsync({
          id,
          type,
          displayName,
        }),
    );

    if (Result.isError(result)) {
      notifyUserError(
        result.error,
        toActionErrorTitle({
          error: result.error,
          fallback: t("errors.actionFailed"),
        }),
      );
      return;
    }

    await queryClient.invalidateQueries({
      queryKey: contactsKeys.all,
    });

    setSelectedClient({
      id,
      displayName,
      type,
    });

    stellaToast.add({
      title: t("success.contactCreated"),
      type: "success",
    });
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setSubmitAttempted(true);
      nameInputRef.current?.focus();
      return;
    }

    const result = await Result.tryPromise(
      async () =>
        await createWorkspace.mutateAsync({
          name: trimmedName,
          ...(selectedClient ? { clientId: selectedClient.id } : {}),
        }),
    );

    if (Result.isError(result)) {
      notifyUserError(
        result.error,
        toActionErrorTitle({
          error: result.error,
          fallback: t("errors.actionFailed"),
        }),
      );
      return;
    }

    const workspaceId = result.value.id;

    if (onCreated) {
      const callbackResult = await Result.tryPromise(
        async () => await onCreated(workspaceId),
      );
      if (Result.isError(callbackResult)) {
        notifyUserError(
          callbackResult.error,
          toActionErrorTitle({
            error: callbackResult.error,
            fallback: t("errors.actionFailed"),
          }),
        );
      }
    }

    handleClose();
    // Navigate to the workspace root immediately and let the index
    // route's beforeLoad redirect land us on the first view. Going
    // straight to /$viewId here would force us to fetch views inline
    // first, leaving the user on the matters listing for the
    // round-trip — which reads as a stall after they just submitted.
    await navigate({
      to: "/workspaces/$workspaceId",
      params: { workspaceId },
      replace: true,
    });
  };

  const canSubmit = !createWorkspace.isPending && !createContact.isPending;
  const nameInvalid = submitAttempted && name.trim().length === 0;
  const possibleDuplicates =
    selectedClient === null
      ? []
      : getPossibleDuplicateMatters({
          clientId: selectedClient.id,
          limit: 3,
          name,
          workspaces: workspacesData ? workspacesData.workspaces : [],
        });

  return (
    <DialogPopup className="max-w-md">
      <DialogFormState
        dirty={name !== "" || selectedClient?.id !== draftClient?.id}
        onDiscard={() => {
          setName("");
          setSelectedClient(draftClient);
        }}
      />
      <DialogHeader>
        <DialogTitle>{t("common.newMatter")}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <QueryViewFeedback view={workspacesDataView} />
        <Field invalid={nameInvalid}>
          <FieldLabel
            className={cn(nameInvalid && "text-destructive-foreground")}
          >
            {t("workspaces.create.matterName")}
          </FieldLabel>
          <Input
            aria-invalid={nameInvalid}
            autoFocus
            maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
            ref={nameInputRef}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                detached(handleSubmit(), "create-matter-dialog.submit");
              }
            }}
            value={name}
          />
          {nameInvalid ? (
            <p className="text-destructive-foreground text-xs">
              {t("common.required")}
            </p>
          ) : null}
        </Field>

        <Field className="gap-3">
          <FieldLabel>{t("workspaces.parties.client")}</FieldLabel>
          {selectedClient ? (
            <SelectedClient
              clearLabel={t("workspaces.parties.removeClient")}
              client={selectedClient}
              onClear={() => setSelectedClient(null)}
            />
          ) : null}
          <ContactPicker
            onCreate={(...args) => {
              detached(
                handleCreateClient(...args),
                "create-matter-dialog.create-client",
              );
            }}
            onSelect={(contact) => {
              setSelectedClient({
                id: contact.id,
                displayName: contact.displayName,
                type: contact.type,
              });
            }}
            placeholder={
              selectedClient
                ? t("workspaces.parties.changeClient")
                : t("workspaces.parties.noClientOptional")
            }
          />
          {selectedClient === null ? (
            <p className="text-muted-foreground text-xs">
              {t("workspaces.create.personalDescription")}
            </p>
          ) : null}
        </Field>

        {possibleDuplicates.length > 0 && (
          <section className="bg-muted/30 space-y-2 rounded-lg border px-3 py-3">
            <h3 className="text-sm font-medium">
              {t("workspaces.possibleDuplicates")}
            </h3>
            <ul className="space-y-1">
              {possibleDuplicates.map((workspace) => (
                <li
                  className="flex items-center gap-2 text-sm"
                  key={workspace.id}
                >
                  <span className="truncate font-medium">{workspace.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {workspace.reference}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={!canSubmit}
          loading={createWorkspace.isPending}
          onClick={() => {
            detached(handleSubmit(), "create-matter-dialog.submit");
          }}
        >
          {t("workspaces.createNewWorkspace")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
