import { useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  BuildingIcon,
  PlusIcon,
  SearchIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { stellaToast } from "@stll/ui/components/toast";

import { ContactPicker } from "@/components/contact-picker";
import { UserIdentity } from "@/components/user-avatar";
import { toSafeId } from "@/lib/safe-id";
import { useCreateContact } from "@/routes/_protected.contacts/-mutations";
import { contactsKeys } from "@/routes/_protected.contacts/-queries";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import {
  buildCollaboratorStats,
  compareMembersByCollaboratorStats,
  getPossibleDuplicateMatters,
} from "@/routes/_protected.workspaces/-components/create-matter-dialog.logic";
import { useCreateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";
import type { WorkspacesData } from "@/routes/_protected.workspaces/-queries";
import type { MatterDraftClient } from "@/routes/_protected.workspaces/-store/create-matter-store";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

type ExistingWorkspace = WorkspacesData["workspaces"][number];

const routeApi = getRouteApi("/_protected");

const SelectedClient = ({ client }: { client: MatterDraftClient }) => (
  <div className="bg-muted/40 flex items-center gap-2 rounded-lg border px-3 py-2">
    {client.type === "person" ? (
      <UserIcon className="text-muted-foreground size-4" />
    ) : (
      <BuildingIcon className="text-muted-foreground size-4" />
    )}
    <span className="truncate text-sm font-medium">{client.displayName}</span>
  </div>
);

type OwnerType = "client" | "personal";

const OwnerTypeToggle = ({
  value,
  onChange,
}: {
  value: OwnerType;
  onChange: (value: OwnerType) => void;
}) => {
  const t = useTranslations();
  return (
    <div
      aria-label={t("workspaces.create.ownerTypeToggle")}
      className="bg-muted/40 inline-flex w-fit gap-1 rounded-lg border p-0.5"
      role="radiogroup"
    >
      <Button
        aria-checked={value === "client"}
        onClick={() => onChange("client")}
        role="radio"
        size="sm"
        variant={value === "client" ? "default" : "ghost"}
      >
        {t("workspaces.ownerType.client")}
      </Button>
      <Button
        aria-checked={value === "personal"}
        onClick={() => onChange("personal")}
        role="radio"
        size="sm"
        variant={value === "personal" ? "default" : "ghost"}
      >
        {t("workspaces.ownerType.personal")}
      </Button>
    </div>
  );
};

const TeamMemberRow = ({
  email,
  image,
  name,
  onRemove,
  removeLabel,
}: {
  email: string;
  image?: string | null | undefined;
  name: string;
  onRemove?: () => void;
  removeLabel?: string;
}) => (
  <div className="bg-background flex items-center gap-2 rounded-md border px-3 py-2">
    <UserIdentity
      avatarClassName="size-8 shrink-0 text-[0.625rem]"
      className="min-w-0 flex-1"
      image={image}
      name={name}
      secondaryText={email}
    />
    {onRemove && (
      <Button
        aria-label={removeLabel}
        className="ms-auto"
        onClick={onRemove}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    )}
  </div>
);

const toActionErrorTitle = ({
  error,
  fallback,
}: {
  error: unknown;
  fallback: string;
}) => (error instanceof Error ? error.message : fallback);

export const CreateMatterDialog = () => {
  const { closeDialog, dialog } = useCreateMatterStore(
    useShallow((s) => ({
      closeDialog: s.closeDialog,
      dialog: s.dialog,
    })),
  );
  const isOpen = dialog.status === "open";
  const draftClient = dialog.status === "open" ? dialog.draftClient : null;

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
        />
      ) : null}
    </Dialog>
  );
};

type CreateMatterDialogBodyProps = {
  closeDialog: () => void;
  draftClient: MatterDraftClient | null;
};

const CreateMatterDialogBody = ({
  closeDialog,
  draftClient,
}: CreateMatterDialogBodyProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const currentUser = routeApi.useRouteContext({
    select: (ctx) => ctx.user,
  });
  const queryClient = useQueryClient();
  const createWorkspace = useCreateWorkspace();
  const createContact = useCreateContact();
  const [name, setName] = useState("");
  const [ownerType, setOwnerType] = useState<"client" | "personal">("client");
  const [selectedClient, setSelectedClient] =
    useState<MatterDraftClient | null>(draftClient);
  const [memberQuery, setMemberQuery] = useState("");
  const [selectedMemberUserIds, setSelectedMemberUserIds] = useState<string[]>(
    [],
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const clientInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { data: organization } = useQuery({
    ...organizationOptions,
  });
  const { data: workspacesData } = useQuery({
    ...workspacesOptions(currentUser.activeOrganizationId),
  });

  const handleClose = () => {
    closeDialog();
  };

  const handleCreateClient = async (
    displayName: string,
    type: "person" | "organization",
  ) => {
    const id = toSafeId<"contact">(crypto.randomUUID());

    const result = await Result.tryPromise(
      async () =>
        await createContact.mutateAsync({
          id,
          type,
          displayName,
        }),
    );

    if (Result.isError(result)) {
      stellaToast.add({
        title: toActionErrorTitle({
          error: result.error,
          fallback: t("errors.actionFailed"),
        }),
        type: "error",
      });
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
    const missingClient = ownerType === "client" && selectedClient === null;
    const missingName = trimmedName.length === 0;

    if (missingClient || missingName) {
      setSubmitAttempted(true);

      if (missingClient) {
        clientInputRef.current?.focus();
        return;
      }

      nameInputRef.current?.focus();
      return;
    }

    const payload = (() => {
      if (ownerType === "personal") {
        return {
          name: trimmedName,
        };
      }
      if (selectedClient) {
        return {
          clientId: selectedClient.id,
          memberUserIds: selectedMemberUserIds,
          name: trimmedName,
        };
      }
      return null;
    })();

    if (!payload) {
      return;
    }

    const result = await Result.tryPromise(
      async () => await createWorkspace.mutateAsync(payload),
    );

    if (Result.isError(result)) {
      stellaToast.add({
        title: toActionErrorTitle({
          error: result.error,
          fallback: t("errors.actionFailed"),
        }),
        type: "error",
      });
      return;
    }

    // Fetch views for the new workspace (the API lazily creates
    // default views on first access) and navigate directly to the
    // first view. This skips the index route redirect which triggers
    // a TanStack Router double-slash path bug when transitioning
    // between workspaces.
    const workspaceId = result.value.id;

    handleClose();
    try {
      const views = await queryClient.fetchQuery(viewsOptions(workspaceId));
      const firstViewId = views.at(0)?.id;

      if (firstViewId) {
        await navigate({
          to: "/workspaces/$workspaceId/$viewId",
          params: { workspaceId, viewId: firstViewId },
          replace: true,
        });
      } else {
        await navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId },
          replace: true,
        });
      }
    } catch {
      // View fetch failed; fall back to the workspace root which
      // triggers the index route redirect as a fallback.
      await navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId },
        replace: true,
      });
    }
  };

  const canSubmit = !createWorkspace.isPending && !createContact.isPending;
  const creatorName = currentUser.name ?? currentUser.email;
  const clientInvalid =
    submitAttempted && ownerType === "client" && selectedClient === null;
  const nameInvalid = submitAttempted && name.trim().length === 0;
  const organizationMembers = useMemo(
    () => organization?.members ?? [],
    [organization?.members],
  );
  const selectedMemberUserIdSet = useMemo(
    () => new Set(selectedMemberUserIds),
    [selectedMemberUserIds],
  );
  const collaboratorStats = useMemo(
    () =>
      buildCollaboratorStats({
        currentUserId: currentUser.id,
        workspaces: workspacesData?.workspaces ?? [],
      }),
    [currentUser.id, workspacesData?.workspaces],
  );
  const availableMembers = useMemo(
    () =>
      organizationMembers
        .filter(
          (member) =>
            member.userId !== currentUser.id &&
            !selectedMemberUserIdSet.has(member.userId),
        )
        .toSorted((a, b) =>
          compareMembersByCollaboratorStats({
            a,
            b,
            collaboratorStats,
          }),
        ),
    [
      collaboratorStats,
      currentUser.id,
      organizationMembers,
      selectedMemberUserIdSet,
    ],
  );
  const filteredMembers = useMemo(() => {
    const trimmedQuery = memberQuery.trim().toLowerCase();

    if (!trimmedQuery) {
      return availableMembers;
    }

    return availableMembers.filter(
      (member) =>
        member.user.name.toLowerCase().includes(trimmedQuery) ||
        member.user.email.toLowerCase().includes(trimmedQuery),
    );
  }, [availableMembers, memberQuery]);
  const selectedMembers = useMemo(
    () =>
      organizationMembers.filter((member) =>
        selectedMemberUserIdSet.has(member.userId),
      ),
    [organizationMembers, selectedMemberUserIdSet],
  );
  const shouldCollapseSelectedMembers = selectedMembers.length > 3;
  const hasAdditionalOrganizationMembers = organizationMembers.length > 1;
  const possibleDuplicates = useMemo(() => {
    if (ownerType === "personal" || selectedClient === null) {
      return [] as ExistingWorkspace[];
    }

    return getPossibleDuplicateMatters({
      clientId: selectedClient.id,
      limit: 3,
      name,
      workspaces: workspacesData?.workspaces ?? [],
    });
  }, [name, ownerType, selectedClient, workspacesData?.workspaces]);

  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>{t("workspaces.newMatter")}</DialogTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        <OwnerTypeToggle onChange={setOwnerType} value={ownerType} />

        {(() => {
          if (ownerType === "client") {
            return (
              <section className="space-y-3">
                <Field className="gap-3" invalid={clientInvalid}>
                  <FieldLabel
                    className={
                      clientInvalid ? "text-destructive-foreground" : undefined
                    }
                  >
                    {t("workspaces.parties.client")}
                  </FieldLabel>
                  {selectedClient && <SelectedClient client={selectedClient} />}
                  <ContactPicker
                    autoFocus={!selectedClient}
                    inputRef={clientInputRef}
                    invalid={clientInvalid}
                    onCreate={(...args) => {
                      void handleCreateClient(...args);
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
                        : t("workspaces.parties.searchContacts")
                    }
                  />
                  {clientInvalid ? (
                    <p className="text-destructive-foreground text-xs">
                      {t("common.required")}
                    </p>
                  ) : null}
                </Field>
              </section>
            );
          }
          return (
            <p className="text-muted-foreground text-xs">
              {t("workspaces.create.personalDescription")}
            </p>
          );
        })()}

        <section>
          <Field invalid={nameInvalid}>
            <FieldLabel
              className={
                nameInvalid ? "text-destructive-foreground" : undefined
              }
            >
              {t("common.name")}
            </FieldLabel>
            <Input
              aria-invalid={nameInvalid}
              autoFocus={!!selectedClient}
              ref={nameInputRef}
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSubmit();
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
        </section>

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

        {ownerType === "client" && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">
              {t("workspaces.sections.members")}
            </h3>

            {(() => {
              if (hasAdditionalOrganizationMembers) {
                return (
                  <div className="space-y-2">
                    <Combobox<(typeof filteredMembers)[number]>
                      itemToStringLabel={(member) =>
                        `${member.user.name} ${member.user.email}`
                      }
                      onInputValueChange={(inputValue) => {
                        setMemberQuery(inputValue);
                      }}
                      onValueChange={(member) => {
                        if (!member) {
                          return;
                        }

                        setSelectedMemberUserIds((current) => [
                          ...current,
                          member.userId,
                        ]);
                        setMemberQuery("");
                      }}
                      value={null}
                    >
                      <ComboboxInput
                        placeholder={t("common.search")}
                        showTrigger={false}
                        startAddon={<SearchIcon />}
                        value={memberQuery}
                      />
                      <ComboboxPopup>
                        <ComboboxList>
                          {filteredMembers.map((member) => (
                            <ComboboxItem key={member.userId} value={member}>
                              <div className="flex items-center gap-2">
                                <UserIdentity
                                  avatarClassName="size-8 shrink-0 text-[0.625rem]"
                                  className="min-w-0 flex-1"
                                  image={member.user.image}
                                  name={member.user.name}
                                  secondaryText={member.user.email}
                                />
                                <PlusIcon className="text-muted-foreground size-4" />
                              </div>
                            </ComboboxItem>
                          ))}
                        </ComboboxList>
                        {filteredMembers.length === 0 ? (
                          <ComboboxEmpty>
                            {memberQuery.length > 0
                              ? t("workspaces.members.noMembersFound")
                              : t("common.search")}
                          </ComboboxEmpty>
                        ) : null}
                      </ComboboxPopup>
                    </Combobox>
                  </div>
                );
              }

              return (
                <div className="bg-muted/20 space-y-3 rounded-lg border border-dashed p-3">
                  <p className="text-muted-foreground text-sm">
                    {t("workspaces.members.noMembersFound")}
                  </p>
                </div>
              );
            })()}

            <div className="bg-muted/20 rounded-lg border p-3">
              {shouldCollapseSelectedMembers ? (
                <ScrollArea className="h-64 w-full" scrollbarGutter>
                  <div className="space-y-2">
                    <TeamMemberRow
                      email={currentUser.email}
                      image={currentUser.image}
                      name={creatorName}
                    />
                    {selectedMembers.map((member) => (
                      <TeamMemberRow
                        email={member.user.email}
                        image={member.user.image}
                        key={member.userId}
                        name={member.user.name}
                        onRemove={() => {
                          setSelectedMemberUserIds((current) =>
                            current.filter(
                              (userId) => userId !== member.userId,
                            ),
                          );
                        }}
                        removeLabel={t("workspaces.members.removeMember")}
                      />
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="space-y-2">
                  <TeamMemberRow
                    email={currentUser.email}
                    image={currentUser.image}
                    name={creatorName}
                  />
                  {selectedMembers.map((member) => (
                    <TeamMemberRow
                      email={member.user.email}
                      image={member.user.image}
                      key={member.userId}
                      name={member.user.name}
                      onRemove={() => {
                        setSelectedMemberUserIds((current) =>
                          current.filter((userId) => userId !== member.userId),
                        );
                      }}
                      removeLabel={t("workspaces.members.removeMember")}
                    />
                  ))}
                </div>
              )}
            </div>
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
            void handleSubmit();
          }}
        >
          {t("workspaces.createNewWorkspace")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
};
