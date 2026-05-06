import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Skeleton } from "@stll/ui/components/skeleton";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BuildingIcon,
  InboxIcon,
  LayersIcon,
  MailIcon,
  PlusIcon,
  PhoneIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { UserIdentity } from "@/components/user-avatar";
import { usePermissions } from "@/hooks/use-permissions";
import { resolveMatterColor } from "@/lib/matter-colors";
import {
  useDeleteContact,
  useUpdateContact,
} from "@/routes/_protected.contacts/-mutations";
import {
  contactOptions,
  contactsKeys,
} from "@/routes/_protected.contacts/-queries";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import {
  PARTY_ROLE_LABEL_KEYS,
  toPartyRole,
} from "@/routes/_protected.workspaces/$workspaceId/-party-roles";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

export const Route = createFileRoute("/_protected/contacts/$contactId")({
  component: ContactDetailPage,
  pendingComponent: () => (
    <div className="flex flex-1 flex-col gap-4 border-t p-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-48 w-full" />
    </div>
  ),
});

type ContactData = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof contactOptions>["queryFn"]>>>
>;

function ContactDetailPage() {
  const t = useTranslations();
  const contactId = Route.useParams({ select: (p) => p.contactId });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: contact } = useSuspenseQuery(contactOptions(contactId));
  const deleteContact = useDeleteContact();
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const deleteBlockedDescription = t("contacts.deleteContactBlockedByMatters");
  const activeClientMatters = contact.clientMatters;

  const handleDelete = async () => {
    await deleteContact.mutateAsync(
      { contactId },
      {
        // eslint-disable-next-line typescript/no-misused-promises
        onSuccess: () => {
          void (async () => {
            stellaToast.add({
              title: t("success.contactDeleted"),
              type: "success",
            });
            await queryClient.invalidateQueries({
              queryKey: contactsKeys.all,
            });
            await navigate({ to: "/contacts" });
          })();
        },
        onError: (error) => {
          stellaToast.add({
            title:
              error instanceof Error ? error.message : t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDeleteOpen = () => {
    if (contact.clientMatterCount > 0) {
      stellaToast.add({
        title: deleteBlockedDescription,
        type: "error",
      });
      return;
    }

    setIsDeleteOpen(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto border-t p-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          // eslint-disable-next-line typescript/no-misused-promises
          onClick={() => {
            void (async () => await navigate({ to: "/contacts" }))();
          }}
          size="icon-xs"
          variant="ghost"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex items-center gap-2">
          {contact.type === "person" ? (
            <UserIcon className="text-muted-foreground size-5" />
          ) : (
            <BuildingIcon className="text-muted-foreground size-5" />
          )}
          <h1 className="text-xl font-bold">{contact.displayName}</h1>
          <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs">
            {t(`contacts.type.${contact.type}`)}
          </span>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {canCreateMatter && (
            <Button
              onClick={() =>
                openCreateMatter({
                  id: contact.id,
                  displayName: contact.displayName,
                  type: contact.type,
                })
              }
              size="sm"
              variant="outline"
            >
              <PlusIcon className="size-4" />
              {t("workspaces.newMatter")}
            </Button>
          )}
          {canDeleteContact && (
            <Button
              disabled={deleteContact.isPending}
              onClick={handleDeleteOpen}
              size="sm"
              variant="destructive"
            >
              {t("contacts.deleteContact")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Identity */}
        <section className="rounded-lg border p-4">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {contact.type === "person"
              ? t("contacts.type.person")
              : t("contacts.type.organization")}
          </h2>
          {contact.type === "person" && (
            <div className="space-y-2 text-sm">
              <EditableRow
                contact={contact}
                field="displayName"
                label={t("contacts.fields.displayName")}
                value={contact.displayName}
              />
              <EditableRow
                contact={contact}
                field="prefix"
                label={t("contacts.fields.prefix")}
                value={contact.prefix}
              />
              <EditableRow
                contact={contact}
                field="firstName"
                label={t("contacts.fields.firstName")}
                value={contact.firstName}
              />
              <EditableRow
                contact={contact}
                field="middleName"
                label={t("contacts.fields.middleName")}
                value={contact.middleName}
              />
              <EditableRow
                contact={contact}
                field="lastName"
                label={t("contacts.fields.lastName")}
                value={contact.lastName}
              />
              <EditableRow
                contact={contact}
                field="suffix"
                label={t("contacts.fields.suffix")}
                value={contact.suffix}
              />
            </div>
          )}
          {contact.type === "organization" && (
            <div className="space-y-2 text-sm">
              <EditableRow
                contact={contact}
                field="displayName"
                label={t("contacts.fields.displayName")}
                value={contact.displayName}
              />
              <EditableRow
                contact={contact}
                field="organizationName"
                label={t("common.organizationName")}
                value={contact.organizationName}
              />
            </div>
          )}
        </section>

        {/* Communication */}
        <section className="rounded-lg border p-4">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("contacts.communication.title")}
          </h2>
          <ContactCommunicationEditor contact={contact} />
        </section>

        {/* Billing details (organizations) */}
        {contact.type === "organization" && (
          <section className="rounded-lg border p-4">
            <h2 className="text-muted-foreground mb-3 text-sm font-medium">
              {t("contacts.billing.title")}
            </h2>
            <div className="space-y-2 text-sm">
              <EditableRow
                contact={contact}
                field="registrationNumber"
                label={t("contacts.fields.registrationNumber")}
                value={contact.registrationNumber}
              />
              <EditableRow
                contact={contact}
                field="taxId"
                label={t("contacts.fields.taxId")}
                value={contact.taxId}
              />
              <EditableRow
                contact={contact}
                field="defaultHourlyRate"
                label={t("contacts.fields.defaultHourlyRate")}
                type="number"
                value={
                  contact.defaultHourlyRate !== null
                    ? String(contact.defaultHourlyRate)
                    : null
                }
              />
              <EditableRow
                contact={contact}
                field="currency"
                label={t("common.currency")}
                value={contact.currency}
              />
              <EditableRow
                contact={contact}
                field="paymentTermDays"
                label={t("contacts.fields.paymentTermDays")}
                type="number"
                value={
                  contact.paymentTermDays !== null
                    ? String(contact.paymentTermDays)
                    : null
                }
              />
              {contact.billingAddress && (
                <div className="min-w-0 rounded-md border p-2">
                  <p className="text-muted-foreground mb-1 text-xs font-medium">
                    {t("contacts.fields.billingAddress")}
                  </p>
                  {contact.billingAddress.line1 && (
                    <InfoRow
                      label={t("contacts.fields.billingAddressLine1")}
                      value={contact.billingAddress.line1}
                    />
                  )}
                  {contact.billingAddress.line2 && (
                    <InfoRow
                      label={t("contacts.fields.billingAddressLine2")}
                      value={contact.billingAddress.line2}
                    />
                  )}
                  {contact.billingAddress.city && (
                    <InfoRow
                      label={t("contacts.fields.billingAddressCity")}
                      value={contact.billingAddress.city}
                    />
                  )}
                  {contact.billingAddress.postalCode && (
                    <InfoRow
                      label={t("contacts.fields.billingAddressPostalCode")}
                      value={contact.billingAddress.postalCode}
                    />
                  )}
                  {contact.billingAddress.state && (
                    <InfoRow
                      label={t("contacts.fields.billingAddressState")}
                      value={contact.billingAddress.state}
                    />
                  )}
                  {contact.billingAddress.country && (
                    <InfoRow
                      label={t("contacts.fields.billingAddressCountry")}
                      value={contact.billingAddress.country}
                    />
                  )}
                </div>
              )}
              {contact.bankAccounts?.map((account, i) => (
                <div
                  className="min-w-0 rounded-md border p-2"
                  key={account.iban ?? account.accountNumber ?? i}
                >
                  {account.bankName && (
                    <InfoRow
                      label={t("contacts.fields.bankAccountBankName")}
                      value={account.bankName}
                    />
                  )}
                  {account.iban && (
                    <InfoRow
                      label={t("contacts.fields.bankAccountIban")}
                      value={account.iban}
                    />
                  )}
                  {account.bic && (
                    <InfoRow
                      label={t("contacts.fields.bankAccountBic")}
                      value={account.bic}
                    />
                  )}
                  {account.accountNumber && (
                    <InfoRow
                      label={t("contacts.fields.bankAccountNumber")}
                      value={account.accountNumber}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <ContactOwnersEditor contact={contact} />

        <ContactCustomFieldsEditor contact={contact} />

        {/* Notes */}
        <section className="rounded-lg border p-4 md:col-span-2">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("common.notes")}
          </h2>
          <ContactNotesEditor contact={contact} />
        </section>

        {/* Matters as client */}
        <section className="rounded-lg border p-4 md:col-span-2">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("contacts.mattersAsClient")}
          </h2>
          {activeClientMatters.length > 0 ? (
            <ul className="space-y-2">
              {activeClientMatters.map((matter) => (
                <li key={matter.id}>
                  <Link
                    className="hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
                    params={{ workspaceId: matter.id }}
                    to="/workspaces/$workspaceId"
                  >
                    <MatterIcon matter={matter} />
                    <span className="font-medium">{matter.name}</span>
                    <span className="text-muted-foreground ms-auto text-xs">
                      {t("common.createdAt", {
                        date: new Date(matter.createdAt).toLocaleDateString(),
                      })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("contacts.noMattersAsClient")}
            </p>
          )}
          {contact.partyCount > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-muted-foreground text-xs">
                {t("contacts.alsoPartyIn", {
                  count: contact.partyCount,
                })}
              </p>
              <ul className="space-y-2">
                {contact.partyMatters.map((matter) => (
                  <li key={matter.id}>
                    <PartyMatterRow matter={matter} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmation={contact.displayName}
        description={t("contacts.deleteContactConfirmDescription")}
        inputLabel={t("common.typeNameToConfirm")}
        loading={deleteContact.isPending}
        onConfirm={handleDelete}
        onOpenChange={setIsDeleteOpen}
        open={isDeleteOpen}
        title={t("contacts.deleteContact")}
      />
    </div>
  );
}

const EmailLink = ({ address }: { address: string }) => (
  <a
    className="hover:text-foreground min-w-0 break-all hover:underline"
    href={`mailto:${address}`}
  >
    {address}
  </a>
);

type ContactEmail = {
  type: "work" | "personal" | "other";
  address: string;
  isPrimary: boolean;
  label?: string;
};

type ContactPhone = {
  type: "mobile" | "office" | "home" | "fax" | "other";
  number: string;
  isPrimary: boolean;
  label?: string;
};

type ContactDataBox = {
  id: string;
  isPrimary: boolean;
  label?: string;
};

type ContactCustomField = {
  id: string;
  label: string;
  value: string;
};

type ContactMetadata = {
  dataBoxes?: ContactDataBox[];
  customFields?: ContactCustomField[];
};

type ContactPatch = {
  emails?: ContactEmail[] | null;
  phones?: ContactPhone[] | null;
  metadata?: ContactMetadata | null;
};

const DATA_BOX_ID_PATTERN = /^[a-z0-9]{7}$/;
const EMAIL_SCHEMA = v.pipe(v.string(), v.trim(), v.email());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isContactDataBox = (value: unknown): value is ContactDataBox =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["isPrimary"] === "boolean" &&
  (value["label"] === undefined || typeof value["label"] === "string");

const isContactCustomField = (value: unknown): value is ContactCustomField =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["label"] === "string" &&
  typeof value["value"] === "string";

const getContactMetadata = (contact: ContactData): ContactMetadata => {
  const metadata = contact.metadata;

  if (!isRecord(metadata)) {
    return {};
  }

  const { customFields, dataBoxes } = metadata;

  return {
    dataBoxes: Array.isArray(dataBoxes)
      ? dataBoxes.filter(isContactDataBox)
      : [],
    customFields: Array.isArray(customFields)
      ? customFields.filter(isContactCustomField)
      : [],
  };
};

type InvalidateContactCachesOptions = {
  invalidateWorkspaces?: boolean;
};

const invalidateContactCaches = async (
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

const useContactPatch = (contact: ContactData) => {
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

const ContactCommunicationEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const { isPending, saveContactPatch } = useContactPatch(contact);
  const [emailDraft, setEmailDraft] = useState("");
  const [phoneDraft, setPhoneDraft] = useState("");
  const [dataBoxDraft, setDataBoxDraft] = useState("");

  const emails = contact.emails ?? [];
  const phones = contact.phones ?? [];
  const metadata = getContactMetadata(contact);
  const dataBoxes = metadata.dataBoxes ?? [];

  const addEmail = () => {
    const address = emailDraft.trim();
    if (!address) {
      return;
    }

    if (!v.safeParse(EMAIL_SCHEMA, address).success) {
      stellaToast.add({
        title: t("contacts.communication.invalidEmail"),
        type: "error",
      });
      return;
    }

    if (
      emails.some(
        (email) => email.address.toLowerCase() === address.toLowerCase(),
      )
    ) {
      stellaToast.add({
        title: t("contacts.communication.alreadyExists"),
        type: "error",
      });
      return;
    }

    saveContactPatch(
      {
        emails: [
          ...emails,
          {
            address,
            isPrimary: emails.length === 0,
            type: "work",
          },
        ],
      },
      () => setEmailDraft(address),
    );
    setEmailDraft("");
  };

  const addPhone = () => {
    const number = phoneDraft.trim();
    if (!number) {
      return;
    }

    if (phones.some((phone) => phone.number === number)) {
      stellaToast.add({
        title: t("contacts.communication.alreadyExists"),
        type: "error",
      });
      return;
    }

    saveContactPatch(
      {
        phones: [
          ...phones,
          {
            isPrimary: phones.length === 0,
            number,
            type: "office",
          },
        ],
      },
      () => setPhoneDraft(number),
    );
    setPhoneDraft("");
  };

  const addDataBox = () => {
    const id = dataBoxDraft.trim().toLowerCase();
    if (!id) {
      return;
    }

    if (!DATA_BOX_ID_PATTERN.test(id)) {
      stellaToast.add({
        title: t("contacts.communication.invalidDataBox"),
        type: "error",
      });
      return;
    }

    if (dataBoxes.some((dataBox) => dataBox.id === id)) {
      stellaToast.add({
        title: t("contacts.communication.alreadyExists"),
        type: "error",
      });
      return;
    }

    saveContactPatch(
      {
        metadata: {
          ...metadata,
          dataBoxes: [
            ...dataBoxes,
            {
              id,
              isPrimary: dataBoxes.length === 0,
            },
          ],
        },
      },
      () => setDataBoxDraft(id),
    );
    setDataBoxDraft("");
  };

  const removeEmail = (address: string) => {
    saveContactPatch({
      emails: emails.filter((email) => email.address !== address),
    });
  };

  const removePhone = (number: string) => {
    saveContactPatch({
      phones: phones.filter((phone) => phone.number !== number),
    });
  };

  const removeDataBox = (id: string) => {
    saveContactPatch({
      metadata: {
        ...metadata,
        dataBoxes: dataBoxes.filter((dataBox) => dataBox.id !== id),
      },
    });
  };

  const hasContactMethods =
    emails.length > 0 || phones.length > 0 || dataBoxes.length > 0;

  return (
    <div className="space-y-4 text-sm">
      <ContactMethodGroup title={t("contacts.communication.emails")}>
        {emails.map((email) => (
          <ContactMethodRow
            disabled={isPending}
            icon={MailIcon}
            key={email.address}
            onRemove={() => removeEmail(email.address)}
          >
            <EmailLink address={email.address} />
            <span className="text-muted-foreground text-xs">
              {t(`contacts.emailTypes.${email.type}`)}
            </span>
          </ContactMethodRow>
        ))}
        <AddContactMethodForm
          buttonLabel={t("contacts.communication.addEmail")}
          disabled={isPending}
          inputMode="email"
          onSubmit={addEmail}
          onValueChange={setEmailDraft}
          placeholder={t("contacts.communication.emailPlaceholder")}
          value={emailDraft}
        />
      </ContactMethodGroup>

      <ContactMethodGroup title={t("contacts.communication.phones")}>
        {phones.map((phone) => (
          <ContactMethodRow
            disabled={isPending}
            icon={PhoneIcon}
            key={phone.number}
            onRemove={() => removePhone(phone.number)}
          >
            <span className="min-w-0 break-all">{phone.number}</span>
            <span className="text-muted-foreground text-xs">
              {t(`contacts.phoneTypes.${phone.type}`)}
            </span>
          </ContactMethodRow>
        ))}
        <AddContactMethodForm
          buttonLabel={t("contacts.communication.addPhone")}
          disabled={isPending}
          inputMode="tel"
          onSubmit={addPhone}
          onValueChange={setPhoneDraft}
          placeholder={t("contacts.communication.phonePlaceholder")}
          value={phoneDraft}
        />
      </ContactMethodGroup>

      <ContactMethodGroup title={t("contacts.communication.dataBoxes")}>
        {dataBoxes.map((dataBox) => (
          <ContactMethodRow
            disabled={isPending}
            icon={InboxIcon}
            key={dataBox.id}
            onRemove={() => removeDataBox(dataBox.id)}
          >
            <span className="font-mono text-xs">{dataBox.id}</span>
          </ContactMethodRow>
        ))}
        <AddContactMethodForm
          buttonLabel={t("contacts.communication.addDataBox")}
          disabled={isPending}
          maxLength={7}
          onSubmit={addDataBox}
          onValueChange={setDataBoxDraft}
          placeholder={t("contacts.communication.dataBoxPlaceholder")}
          value={dataBoxDraft}
        />
      </ContactMethodGroup>

      {!hasContactMethods && (
        <p className="text-muted-foreground">{t("contacts.noContactsFound")}</p>
      )}
    </div>
  );
};

const ContactMethodGroup = ({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) => (
  <div className="space-y-2">
    <p className="text-muted-foreground text-xs font-medium">{title}</p>
    {children}
  </div>
);

const ContactMethodRow = ({
  children,
  disabled,
  icon: Icon,
  onRemove,
}: {
  children: ReactNode;
  disabled: boolean;
  icon: LucideIcon;
  onRemove: () => void;
}) => {
  const t = useTranslations();

  return (
    <div className="group flex min-w-0 items-center gap-2">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">{children}</div>
      <Button
        aria-label={t("common.delete")}
        className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        disabled={disabled}
        onClick={onRemove}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
};

const AddContactMethodForm = ({
  buttonLabel,
  disabled,
  inputMode,
  maxLength,
  onSubmit,
  onValueChange,
  placeholder,
  type = "text",
  value,
}: {
  buttonLabel: string;
  disabled: boolean;
  inputMode?: "email" | "tel";
  maxLength?: number;
  onSubmit: () => void;
  onValueChange: (value: string) => void;
  placeholder: string;
  type?: "text";
  value: string;
}) => (
  <form
    className="flex gap-2"
    noValidate
    onSubmit={(event) => {
      event.preventDefault();
      onSubmit();
    }}
  >
    <Input
      className="h-8 min-w-0 flex-1 text-sm"
      disabled={disabled}
      inputMode={inputMode}
      maxLength={maxLength}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      placeholder={placeholder}
      type={type}
      value={value}
    />
    <Button
      disabled={disabled || value.trim().length === 0}
      size="sm"
      type="submit"
    >
      <PlusIcon className="size-4" />
      {buttonLabel}
    </Button>
  </form>
);

const ContactCustomFieldsEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const { isPending, saveContactPatch, saveContactPatchAsync } =
    useContactPatch(contact);
  const [labelDraft, setLabelDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");
  const metadata = getContactMetadata(contact);
  const customFields = metadata.customFields ?? [];

  const addCustomField = () => {
    const label = labelDraft.trim();
    if (!label) {
      return;
    }

    saveContactPatch(
      {
        metadata: {
          ...metadata,
          customFields: [
            ...customFields,
            {
              id: crypto.randomUUID(),
              label,
              value: valueDraft.trim(),
            },
          ],
        },
      },
      () => {
        setLabelDraft(label);
        setValueDraft(valueDraft);
      },
    );
    setLabelDraft("");
    setValueDraft("");
  };

  const updateCustomField = async (
    fieldId: string,
    patch: ContactCustomField,
  ) => {
    const label = patch.label.trim();
    const value = patch.value.trim();

    if (!label) {
      stellaToast.add({
        title: t("contacts.customFields.labelRequired"),
        type: "error",
      });
      return false;
    }

    return await saveContactPatchAsync({
      metadata: {
        ...metadata,
        customFields: customFields.map((field) =>
          field.id === fieldId
            ? {
                ...patch,
                label,
                value,
              }
            : field,
        ),
      },
    });
  };

  const removeCustomField = (fieldId: string) => {
    saveContactPatch({
      metadata: {
        ...metadata,
        customFields: customFields.filter((field) => field.id !== fieldId),
      },
    });
  };

  return (
    <section className="rounded-lg border p-4 md:col-span-2">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.customFields.title")}
      </h2>
      <div className="space-y-3">
        {customFields.map((field) => (
          <CustomFieldRow
            disabled={isPending}
            field={field}
            key={field.id}
            onRemove={() => removeCustomField(field.id)}
            onSave={async (patch) => await updateCustomField(field.id, patch)}
          />
        ))}
        {customFields.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("contacts.customFields.empty")}
          </p>
        )}
        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            addCustomField();
          }}
        >
          <Input
            disabled={isPending}
            maxLength={128}
            onChange={(event) => setLabelDraft(event.currentTarget.value)}
            placeholder={t("contacts.customFields.labelPlaceholder")}
            value={labelDraft}
          />
          <Input
            disabled={isPending}
            maxLength={2000}
            onChange={(event) => setValueDraft(event.currentTarget.value)}
            placeholder={t("contacts.customFields.valuePlaceholder")}
            value={valueDraft}
          />
          <Button
            disabled={isPending || labelDraft.trim().length === 0}
            type="submit"
          >
            <PlusIcon className="size-4" />
            {t("contacts.customFields.addField")}
          </Button>
        </form>
      </div>
    </section>
  );
};

const CustomFieldRow = ({
  disabled,
  field,
  onRemove,
  onSave,
}: {
  disabled: boolean;
  field: ContactCustomField;
  onRemove: () => void;
  onSave: (field: ContactCustomField) => Promise<boolean>;
}) => {
  const t = useTranslations();
  const [label, setLabel] = useState(field.label);
  const [value, setValue] = useState(field.value);
  const latestFieldRef = useRef({ label: field.label, value: field.value });

  useEffect(() => {
    const nextField = { label: field.label, value: field.value };
    setLabel((currentLabel) =>
      currentLabel === latestFieldRef.current.label
        ? nextField.label
        : currentLabel,
    );
    setValue((currentValue) =>
      currentValue === latestFieldRef.current.value
        ? nextField.value
        : currentValue,
    );
    latestFieldRef.current = nextField;
  }, [field.label, field.value]);

  const save = async () => {
    if (label === field.label && value === field.value) {
      return;
    }

    const nextField = {
      ...field,
      label: label.trim(),
      value: value.trim(),
    };

    if (!(await onSave(nextField))) {
      return;
    }

    setLabel(nextField.label);
    setValue(nextField.value);
  };

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
      <Input
        aria-label={t("contacts.customFields.label")}
        disabled={disabled}
        maxLength={128}
        onBlur={() => {
          // eslint-disable-next-line typescript/no-floating-promises
          save();
        }}
        onChange={(event) => setLabel(event.currentTarget.value)}
        value={label}
      />
      <Input
        aria-label={t("contacts.customFields.value")}
        disabled={disabled}
        maxLength={2000}
        onBlur={() => {
          // eslint-disable-next-line typescript/no-floating-promises
          save();
        }}
        onChange={(event) => setValue(event.currentTarget.value)}
        value={value}
      />
      <Button
        aria-label={t("contacts.customFields.removeField")}
        disabled={disabled}
        onClick={onRemove}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <Trash2Icon className="size-4" />
      </Button>
    </div>
  );
};

type PartyMatter = ContactData["partyMatters"][number];

const PartyMatterRow = ({ matter }: { matter: PartyMatter }) => {
  const t = useTranslations();

  return (
    <Link
      className="hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
      params={{ workspaceId: matter.id }}
      to="/workspaces/$workspaceId"
    >
      <MatterIcon matter={matter} />
      <span className="font-medium">{matter.name}</span>
      <div className="ms-auto flex flex-wrap justify-end gap-1">
        {matter.roles.map((role) => {
          const parsedRole = toPartyRole(role);
          const roleKey = parsedRole
            ? PARTY_ROLE_LABEL_KEYS[parsedRole]
            : PARTY_ROLE_LABEL_KEYS.other;

          return (
            <span
              className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs"
              key={role}
            >
              {t(roleKey)}
            </span>
          );
        })}
      </div>
    </Link>
  );
};

// Read-only row for non-editable fields
const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline gap-2">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <span className="min-w-0 break-all">{value}</span>
  </div>
);

const NO_OWNER_VALUE = "__none";

const ContactOwnersEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const { data: organization } = useQuery(organizationOptions);

  const memberItems = (organization?.members ?? []).map((member) => ({
    email: member.user.email,
    image: member.user.image,
    name: member.user.name,
    value: member.userId,
  }));

  const updateOwner = (
    field: "originatingAttorneyId" | "responsibleAttorneyId",
    value: string | null,
  ) => {
    const nextValue = value === NO_OWNER_VALUE ? null : value;
    if (contact[field] === nextValue) {
      return;
    }

    updateContact.mutate(
      {
        contactId: contact.id,
        [field]: nextValue,
      },
      {
        onSuccess: () => {
          void invalidateContactCaches(queryClient, contact.id, {
            invalidateWorkspaces: field === "responsibleAttorneyId",
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

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-muted-foreground mb-3 text-sm font-medium">
        {t("contacts.attorneys.title")}
      </h2>
      <div className="space-y-3 text-sm">
        <OwnerSelect
          disabled={updateContact.isPending}
          label={t("contacts.attorneys.originating")}
          members={memberItems}
          noneLabel={t("contacts.attorneys.none")}
          onValueChange={(value) => updateOwner("originatingAttorneyId", value)}
          selectedOwner={contact.originatingAttorney}
          value={contact.originatingAttorneyId ?? NO_OWNER_VALUE}
        />
        <OwnerSelect
          disabled={updateContact.isPending}
          label={t("contacts.attorneys.responsible")}
          members={memberItems}
          noneLabel={t("contacts.attorneys.none")}
          onValueChange={(value) => updateOwner("responsibleAttorneyId", value)}
          selectedOwner={contact.responsibleAttorney}
          value={contact.responsibleAttorneyId ?? NO_OWNER_VALUE}
        />
      </div>
    </section>
  );
};

type OwnerSelectProps = {
  disabled: boolean;
  label: string;
  members: {
    email: string;
    image?: string | null | undefined;
    name: string;
    value: string;
  }[];
  noneLabel: string;
  onValueChange: (value: string | null) => void;
  selectedOwner?: {
    id: string;
    image: string | null;
    name: string;
  } | null;
  value: string;
};

const OwnerSelect = ({
  disabled,
  label,
  members,
  noneLabel,
  onValueChange,
  selectedOwner,
  value,
}: OwnerSelectProps) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <Select disabled={disabled} onValueChange={onValueChange} value={value}>
      <SelectTrigger className="min-w-0 flex-1">
        <SelectValue>
          {(current) => {
            const member = members.find((item) => item.value === current);
            if (!member) {
              if (current === NO_OWNER_VALUE) {
                return (
                  <span className="text-muted-foreground">{noneLabel}</span>
                );
              }

              if (selectedOwner) {
                return (
                  <UserIdentity
                    avatarClassName="size-7 shrink-0 text-[0.625rem]"
                    className="min-w-0"
                    image={selectedOwner.image}
                    name={selectedOwner.name}
                  />
                );
              }

              return <span className="text-muted-foreground">{noneLabel}</span>;
            }

            return (
              <UserIdentity
                avatarClassName="size-7 shrink-0 text-[0.625rem]"
                className="min-w-0"
                image={member.image}
                name={member.name}
                secondaryText={member.email}
              />
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={NO_OWNER_VALUE}>
          <span className="text-muted-foreground">{noneLabel}</span>
        </SelectItem>
        {members.map((member) => (
          <SelectItem key={member.value} value={member.value}>
            <UserIdentity
              avatarClassName="size-7 shrink-0 text-[0.625rem]"
              className="min-w-0"
              image={member.image}
              name={member.name}
              secondaryText={member.email}
            />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  </div>
);

// Fields that can be sent to the update endpoint
type EditableField =
  | "prefix"
  | "firstName"
  | "middleName"
  | "lastName"
  | "suffix"
  | "organizationName"
  | "displayName"
  | "notes"
  | "registrationNumber"
  | "taxId"
  | "defaultHourlyRate"
  | "currency"
  | "paymentTermDays";

const FIELD_MAX_LENGTH: Partial<Record<EditableField, number>> = {
  prefix: 32,
  firstName: 256,
  middleName: 256,
  lastName: 256,
  suffix: 32,
  organizationName: 512,
  displayName: 512,
  registrationNumber: 64,
  taxId: 64,
  currency: 3,
};

type EditableRowProps = {
  label: string;
  value: string | null | undefined;
  field: EditableField;
  contact: ContactData;
  type?: "text" | "number";
};

const ContactNotesEditor = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const [draft, setDraft] = useState(contact.notes ?? "");
  const latestServerNotesRef = useRef(contact.notes ?? "");
  const skipNextSaveRef = useRef(false);

  useEffect(() => {
    const nextNotes = contact.notes ?? "";
    setDraft((currentDraft) =>
      currentDraft === latestServerNotesRef.current ? nextNotes : currentDraft,
    );
    latestServerNotesRef.current = nextNotes;
  }, [contact.notes]);

  const handleSave = () => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    const current = contact.notes ?? "";
    if (draft === current) {
      return;
    }

    updateContact.mutate(
      {
        contactId: contact.id,
        notes: draft.trim().length === 0 ? null : draft,
      },
      {
        onSuccess: () => {
          void invalidateContactCaches(queryClient, contact.id);
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          setDraft(current);
        },
      },
    );
  };

  return (
    <Textarea
      aria-label={t("common.notes")}
      className="min-h-28"
      disabled={updateContact.isPending}
      onBlur={handleSave}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          skipNextSaveRef.current = true;
          setDraft(contact.notes ?? "");
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      placeholder="—"
      value={draft}
    />
  );
};

const EditableRow = ({
  label,
  value,
  field,
  contact,
  type = "text",
}: EditableRowProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState(value ?? "");

  const maxLength = FIELD_MAX_LENGTH[field];

  const handleSave = () => {
    setIsEditing(false);
    const trimmed = inputValue.trim();
    const current = value ?? "";

    if (trimmed === current) {
      return;
    }

    if (maxLength !== undefined && trimmed.length > maxLength) {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
      setInputValue(value ?? "");
      return;
    }

    let payload: Record<string, unknown>;
    if (field === "defaultHourlyRate" || field === "paymentTermDays") {
      const parsed = trimmed ? Number.parseInt(trimmed, 10) : null;
      if (parsed !== null && (Number.isNaN(parsed) || parsed < 0)) {
        setInputValue(value ?? "");
        return;
      }
      if (field === "paymentTermDays" && parsed !== null && parsed > 365) {
        setInputValue(value ?? "");
        return;
      }
      payload = { [field]: parsed };
    } else if (field === "displayName") {
      if (!trimmed) {
        stellaToast.add({
          title: t("errors.actionFailed"),
          type: "error",
        });
        setInputValue(value ?? "");
        return;
      }
      payload = { displayName: trimmed };
    } else {
      payload = { [field]: trimmed || null };
    }

    updateContact.mutate(
      { contactId: contact.id, ...payload },
      {
        onSuccess: () => {
          void invalidateContactCaches(queryClient, contact.id, {
            invalidateWorkspaces: field === "displayName",
          });
        },
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
          setInputValue(value ?? "");
        },
      },
    );
  };

  if (isEditing) {
    return (
      <div className="flex items-baseline gap-2">
        {label && (
          <span className="text-muted-foreground w-32 shrink-0">{label}</span>
        )}
        <Input
          autoFocus
          className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none outline-none focus-visible:ring-0"
          maxLength={maxLength}
          onBlur={handleSave}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
            if (e.key === "Escape") {
              setInputValue(value ?? "");
              setIsEditing(false);
            }
          }}
          type={type}
          value={inputValue}
        />
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-2">
      {label && (
        <span className="text-muted-foreground w-32 shrink-0">{label}</span>
      )}
      <button
        className="hover:text-foreground cursor-text text-start text-sm"
        onClick={() => {
          setInputValue(value ?? "");
          setIsEditing(true);
        }}
        type="button"
      >
        {value || <span className="text-muted-foreground/50">—</span>}
      </button>
    </div>
  );
};

const MatterIcon = ({
  matter,
}: {
  matter: { id: string; color: string | null };
}) => {
  const activeColor = resolveMatterColor(matter.id, matter.color);

  return (
    <LayersIcon className="size-4 shrink-0" style={{ color: activeColor }} />
  );
};
