import { useState } from "react";

import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BuildingIcon,
  LockIcon,
  PlusIcon,
  TrashIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { ContactPicker } from "@/components/contact-picker";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { useCreateContact } from "@/routes/_protected.contacts/-mutations";
import { contactsKeys } from "@/routes/_protected.contacts/-queries";
import { MATTER_INFO_ICON_SLOT_CLASS } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-info-layout";
import {
  PARTY_ROLES,
  PARTY_ROLE_LABEL_KEYS,
  toPartyRole,
} from "@/routes/_protected.workspaces/$workspaceId/-party-roles";
import type { PartyRole } from "@/routes/_protected.workspaces/$workspaceId/-party-roles";
import {
  workspaceContactsKeys,
  workspaceContactsOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-contacts";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import {
  workspaceOptions,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";

type PartiesSectionProps = {
  workspaceId: string;
};

export const PartiesSection = ({ workspaceId }: PartiesSectionProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { data: workspace } = useSuspenseQuery(workspaceOptions(workspaceId));
  const { data: parties = [] } = useQuery(
    workspaceContactsOptions(workspaceId),
  );
  const updateWorkspace = useUpdateWorkspace();
  const createContact = useCreateContact();

  const handleCreateAndSetClient = (
    name: string,
    type: "person" | "organization",
  ) => {
    const id = toSafeId<"contact">(crypto.randomUUID());
    createContact.mutate(
      { id, type, displayName: name },
      {
        onSuccess: () => {
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: contactsKeys.all,
          });
          handleSetClient({ id, displayName: name });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleSetClient = (contact: { id: string; displayName: string }) => {
    updateWorkspace.mutate(
      { workspaceId, clientId: contact.id },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.clientUpdated"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.byId(workspaceId),
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const { client } = workspace;
  if (!client) {
    return (
      <div className="flex flex-col p-3">
        <section className="bg-muted/30 flex flex-col gap-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <LockIcon className="text-muted-foreground size-4" />
            <h3 className="text-sm font-medium">
              {t("workspaces.parties.personalLabel")}
            </h3>
          </div>
          <p className="text-muted-foreground text-sm">
            {t("workspaces.parties.personalDescription")}
          </p>
          <PromoteDialog workspaceId={workspaceId} />
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Client sub-section */}
      <section>
        <div
          className={cn(
            "flex items-center justify-between gap-2 px-3",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <h3 className="text-muted-foreground text-sm font-medium">
            {t("workspaces.parties.client")}
          </h3>
          <ChangeClientDialog
            onCreate={handleCreateAndSetClient}
            onSelect={handleSetClient}
          />
        </div>
        <div className={cn("flex items-center gap-2 px-3", TOOLBAR_ROW_HEIGHT)}>
          {client.type === "person" ? (
            <span className={MATTER_INFO_ICON_SLOT_CLASS}>
              <UserIcon className="text-muted-foreground size-4" />
            </span>
          ) : (
            <span className={MATTER_INFO_ICON_SLOT_CLASS}>
              <BuildingIcon className="text-muted-foreground size-4" />
            </span>
          )}
          <Link
            className="min-w-0 truncate text-sm font-medium hover:underline"
            params={{ contactId: client.id }}
            to="/contacts/$contactId"
          >
            {client.displayName}
          </Link>
        </div>
      </section>

      {/* Parties sub-section */}
      <section>
        <div
          className={cn(
            "flex items-center justify-between gap-2 px-3",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <h3 className="text-muted-foreground text-sm font-medium">
            {t("workspaces.sections.parties")}
          </h3>
          <AddPartyDialog showTriggerLabel={false} workspaceId={workspaceId} />
        </div>
        {parties.length > 0 ? (
          <ul>
            {parties.map((party) => (
              <PartyRow
                key={party.id}
                party={party}
                workspaceId={workspaceId}
              />
            ))}
          </ul>
        ) : (
          <p
            className={cn(
              "text-muted-foreground flex items-center px-3 text-sm italic",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            {t("workspaces.parties.noParties")}
          </p>
        )}
      </section>
    </div>
  );
};

type ChangeClientDialogProps = {
  onCreate: (name: string, type: "person" | "organization") => void;
  onSelect: (contact: { id: string; displayName: string }) => void;
};

const ChangeClientDialog = ({
  onCreate,
  onSelect,
}: ChangeClientDialogProps) => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog onOpenChange={setIsOpen} open={isOpen}>
      <DialogTrigger
        render={
          <Button
            aria-label={t("workspaces.parties.changeClient")}
            size="icon-xs"
            title={t("workspaces.parties.changeClient")}
            variant="ghost"
          />
        }
      >
        <PlusIcon className="size-3.5" />
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("workspaces.parties.changeClient")}</DialogTitle>
          <DialogDescription />
        </DialogHeader>
        <DialogPanel>
          <ContactPicker
            autoFocus
            onCreate={(name, type) => {
              onCreate(name, type);
              setIsOpen(false);
            }}
            onSelect={(contact) => {
              onSelect(contact);
              setIsOpen(false);
            }}
            placeholder={t("workspaces.parties.changeClient")}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
};

type PromoteDialogProps = {
  workspaceId: string;
};

const PromoteDialog = ({ workspaceId }: PromoteDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateWorkspace = useUpdateWorkspace();
  const createContact = useCreateContact();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<{
    id: string;
    displayName: string;
  } | null>(null);

  const handleClose = () => {
    setIsOpen(false);
    setSelectedContact(null);
  };

  const handleCreateContact = (
    name: string,
    type: "person" | "organization",
  ) => {
    const id = toSafeId<"contact">(crypto.randomUUID());
    createContact.mutate(
      { id, type, displayName: name },
      {
        onSuccess: () => {
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: contactsKeys.all,
          });
          setSelectedContact({ id, displayName: name });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleSubmit = () => {
    if (!selectedContact) {
      return;
    }

    updateWorkspace.mutate(
      {
        workspaceId,
        promote: { clientId: selectedContact.id },
      },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("workspaces.parties.promotedSuccess"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.byId(workspaceId),
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.all,
          });
          handleClose();
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
          return;
        }
        setIsOpen(true);
      }}
      open={isOpen}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        {t("workspaces.parties.promoteCta")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("workspaces.parties.promoteCta")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.parties.promoteDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div>
            <span className="mb-1.5 block text-sm font-medium">
              {t("workspaces.parties.client")}
            </span>
            {selectedContact ? (
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <span>{selectedContact.displayName}</span>
                <Button
                  className="ms-auto"
                  onClick={() => setSelectedContact(null)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <ContactPicker
                autoFocus
                onCreate={handleCreateContact}
                onSelect={(contact) =>
                  setSelectedContact({
                    id: contact.id,
                    displayName: contact.displayName,
                  })
                }
              />
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!selectedContact}
            loading={updateWorkspace.isPending}
            onClick={handleSubmit}
          >
            {t("workspaces.parties.promoteCta")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type PartyData = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof workspaceContactsOptions>["queryFn"]>
    >
  >
>[number];

type PartyRowProps = {
  party: PartyData;
  workspaceId: string;
};

const PartyRow = ({ party, workspaceId }: PartyRowProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const removeParty = useMutation({
    mutationFn: async (vars: {
      workspaceId: string;
      workspaceContactId: string;
    }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(vars.workspaceId) })
        .contacts({
          workspaceContactId: toSafeId<"workspaceContact">(
            vars.workspaceContactId,
          ),
        })
        .delete({
          queryKey: workspaceContactsKeys.all(vars.workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  if (!party.contact) {
    return null;
  }

  const { contact } = party;

  const handleRemove = () => {
    removeParty.mutate(
      {
        workspaceId,
        workspaceContactId: party.id,
      },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.partyRemoved"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspaceContactsOptions(workspaceId).queryKey,
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const parsedRole = toPartyRole(party.role);
  const roleKey = parsedRole
    ? PARTY_ROLE_LABEL_KEYS[parsedRole]
    : PARTY_ROLE_LABEL_KEYS.other;

  return (
    <li className={cn("flex items-center gap-2 px-3", TOOLBAR_ROW_HEIGHT)}>
      {contact.type === "person" ? (
        <span className={MATTER_INFO_ICON_SLOT_CLASS}>
          <UserIcon className="text-muted-foreground size-4" />
        </span>
      ) : (
        <span className={MATTER_INFO_ICON_SLOT_CLASS}>
          <BuildingIcon className="text-muted-foreground size-4" />
        </span>
      )}
      <Link
        className="text-sm font-medium hover:underline"
        params={{ contactId: contact.id }}
        to="/contacts/$contactId"
      >
        {contact.displayName}
      </Link>
      <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs">
        {t(roleKey)}
      </span>
      <Button
        aria-label={t("workspaces.parties.removeParty")}
        className="ms-auto"
        disabled={removeParty.isPending}
        onClick={handleRemove}
        size="icon-xs"
        variant="ghost"
      >
        <TrashIcon className="size-3.5" />
      </Button>
    </li>
  );
};

type AddPartyDialogProps = {
  workspaceId: string;
  showTriggerLabel?: boolean | undefined;
};

const AddPartyDialog = ({
  workspaceId,
  showTriggerLabel = true,
}: AddPartyDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const addParty = useMutation({
    mutationFn: async ({
      workspaceId: ws,
      ...body
    }: {
      workspaceId: string;
      contactId: string;
      role: PartyRole;
      isPrimary?: boolean;
      notes?: string | null;
    }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(ws) })
        .contacts.put({
          ...body,
          contactId: toSafeId<"contact">(body.contactId),
          queryKey: workspaceContactsKeys.all(ws),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });
  const [isOpen, setIsOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<{
    id: string;
    displayName: string;
  } | null>(null);
  const [selectedRole, setSelectedRole] = useState<PartyRole | null>(null);

  const roleItems = PARTY_ROLES.map((role) => ({
    label: t(PARTY_ROLE_LABEL_KEYS[role]),
    value: role,
  }));

  const handleSubmit = () => {
    if (!selectedContact || !selectedRole) {
      return;
    }

    addParty.mutate(
      {
        workspaceId,
        contactId: selectedContact.id,
        role: selectedRole,
      },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.partyAdded"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspaceContactsOptions(workspaceId).queryKey,
          });
          setIsOpen(false);
          setSelectedContact(null);
          setSelectedRole(null);
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleRoleChange = (value: string | null) => {
    setSelectedRole(value ? toPartyRole(value) : null);
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          setSelectedContact(null);
          setSelectedRole(null);
        }
      }}
      open={isOpen}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={t("workspaces.parties.addParty")}
            size={showTriggerLabel ? "sm" : "icon-xs"}
            title={t("workspaces.parties.addParty")}
            variant={showTriggerLabel ? "outline" : "ghost"}
          />
        }
      >
        <PlusIcon className="size-3.5" />
        {showTriggerLabel ? t("workspaces.parties.addParty") : null}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("workspaces.parties.addParty")}</DialogTitle>
          <DialogDescription />
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div>
            <span className="mb-1.5 block text-sm font-medium">
              {t("contacts.title")}
            </span>
            {selectedContact ? (
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <span>{selectedContact.displayName}</span>
                <Button
                  className="ms-auto"
                  onClick={() => setSelectedContact(null)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : (
              <ContactPicker
                autoFocus
                onSelect={(contact) =>
                  setSelectedContact({
                    id: contact.id,
                    displayName: contact.displayName,
                  })
                }
              />
            )}
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium">
              {t("common.role")}
            </span>
            <Select
              items={roleItems}
              onValueChange={handleRoleChange}
              value={selectedRole}
            >
              <SelectTrigger>
                <SelectValue>
                  {(current) =>
                    // oxlint-disable-next-line typescript/strict-boolean-expressions: tsgo issue
                    current
                      ? roleItems.find((r) => r.value === current)?.label
                      : t("common.selectARole")
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {roleItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!selectedContact || !selectedRole}
            loading={addParty.isPending}
            onClick={handleSubmit}
          >
            {t("workspaces.parties.addParty")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
