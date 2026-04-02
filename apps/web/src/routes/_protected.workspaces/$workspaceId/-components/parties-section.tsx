import { useState } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BuildingIcon,
  PlusIcon,
  TrashIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
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
} from "@stella/ui/components/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { ContactPicker } from "@/components/contact-picker";
import { useCreateContact } from "@/routes/_protected.contacts/-mutations";
import { contactsKeys } from "@/routes/_protected.contacts/-queries";
import {
  useAddParty,
  useRemoveParty,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/workspace-contacts";
import {
  PARTY_ROLES,
  toPartyRole,
} from "@/routes/_protected.workspaces/$workspaceId/-party-roles";
import type { PartyRole } from "@/routes/_protected.workspaces/$workspaceId/-party-roles";
import { workspaceContactsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-contacts";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import {
  workspaceOptions,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";

const ROLE_LABEL_KEYS = {
  opposing_party: "workspaces.parties.partyRoles.opposing_party",
  opposing_counsel: "workspaces.parties.partyRoles.opposing_counsel",
  co_counsel: "workspaces.parties.partyRoles.co_counsel",
  witness: "workspaces.parties.partyRoles.witness",
  expert_witness: "workspaces.parties.partyRoles.expert_witness",
  third_party: "workspaces.parties.partyRoles.third_party",
  judge: "workspaces.parties.partyRoles.judge",
  mediator: "workspaces.parties.partyRoles.mediator",
  other: "workspaces.parties.partyRoles.other",
} as const;

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
    const id = crypto.randomUUID();
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
          toastManager.add({
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
          toastManager.add({
            title: t("success.clientUpdated"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.byId(workspaceId),
          });
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleRemoveClient = () => {
    updateWorkspace.mutate(
      { workspaceId, clientId: null },
      {
        onSuccess: () => {
          toastManager.add({
            title: t("success.clientUpdated"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.byId(workspaceId),
          });
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-auto p-4">
      {/* Client sub-section */}
      <section>
        <h3 className="text-muted-foreground mb-3 text-sm font-medium">
          {t("workspaces.parties.client")}
        </h3>
        {workspace.client ? (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2">
            {workspace.client.type === "person" ? (
              <UserIcon className="text-muted-foreground size-4" />
            ) : (
              <BuildingIcon className="text-muted-foreground size-4" />
            )}
            <Link
              className="text-sm font-medium hover:underline"
              params={{ contactId: workspace.client.id }}
              to="/contacts/$contactId"
            >
              {workspace.client.displayName}
            </Link>
            <Button
              aria-label={t("workspaces.parties.removeClient")}
              className="ms-auto"
              onClick={handleRemoveClient}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              {t("workspaces.parties.noClient")}
            </p>
            <ContactPicker
              onCreate={handleCreateAndSetClient}
              onSelect={handleSetClient}
            />
          </div>
        )}
        {workspace.client && (
          <div className="mt-2">
            <ContactPicker
              onCreate={handleCreateAndSetClient}
              onSelect={handleSetClient}
              placeholder={t("workspaces.parties.changeClient")}
            />
          </div>
        )}
      </section>

      {/* Parties sub-section */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-muted-foreground text-sm font-medium">
            {t("workspaces.sections.parties")}
          </h3>
          <AddPartyDialog workspaceId={workspaceId} />
        </div>
        {parties.length > 0 ? (
          <ul className="space-y-1">
            {parties.map((party) => (
              <PartyRow
                key={party.id}
                party={party}
                workspaceId={workspaceId}
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("workspaces.parties.noParties")}
          </p>
        )}
      </section>
    </div>
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
  const removeParty = useRemoveParty();

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
          toastManager.add({
            title: t("success.partyRemoved"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspaceContactsOptions(workspaceId).queryKey,
          });
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const parsedRole = toPartyRole(party.role);
  const roleKey = parsedRole
    ? ROLE_LABEL_KEYS[parsedRole]
    : ROLE_LABEL_KEYS.other;

  return (
    <li className="flex items-center gap-2 rounded-md border px-3 py-2">
      {contact.type === "person" ? (
        <UserIcon className="text-muted-foreground size-4" />
      ) : (
        <BuildingIcon className="text-muted-foreground size-4" />
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
};

const AddPartyDialog = ({ workspaceId }: AddPartyDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const addParty = useAddParty();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<{
    id: string;
    displayName: string;
  } | null>(null);
  const [selectedRole, setSelectedRole] = useState<PartyRole | null>(null);

  const roleItems = PARTY_ROLES.map((role) => ({
    label: t(ROLE_LABEL_KEYS[role]),
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
          toastManager.add({
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
          toastManager.add({
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
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon className="size-3.5" />
        {t("workspaces.parties.addParty")}
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
