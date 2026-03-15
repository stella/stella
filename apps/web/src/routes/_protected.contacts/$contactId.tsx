import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BuildingIcon,
  LayersIcon,
  MailIcon,
  PhoneIcon,
  UserIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import { Input } from "@stella/ui/components/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stella/ui/components/popover";
import { Skeleton } from "@stella/ui/components/skeleton";
import { toastManager } from "@stella/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { getMatterSwatch, MATTER_SWATCHES } from "@/lib/matter-colors";
import {
  useDeleteContact,
  useUpdateContact,
} from "@/routes/_protected.contacts/-mutations";
import {
  contactOptions,
  contactsKeys,
} from "@/routes/_protected.contacts/-queries";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";

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
  const { contactId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: contact } = useSuspenseQuery(contactOptions(contactId));
  const deleteContact = useDeleteContact();
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const handleDelete = () => {
    deleteContact.mutate(
      { contactId },
      {
        // eslint-disable-next-line typescript/no-misused-promises
        onSuccess: async () => {
          toastManager.add({
            title: t("success.contactDeleted"),
            type: "success",
          });
          await queryClient.invalidateQueries({
            queryKey: contactsKeys.all,
          });
          await navigate({ to: "/contacts" });
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

  const primaryEmail =
    contact.emails?.find((e) => e.isPrimary) ?? contact.emails?.at(0);
  const primaryPhone =
    contact.phones?.find((p) => p.isPrimary) ?? contact.phones?.at(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto border-t p-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          // eslint-disable-next-line typescript/no-misused-promises
          onClick={async () => await navigate({ to: "/contacts" })}
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
        {canDeleteContact && (
          <div className="ms-auto">
            <Button
              disabled={deleteContact.isPending}
              onClick={() => setIsDeleteOpen(true)}
              size="sm"
              variant="destructive"
            >
              {t("contacts.deleteContact")}
            </Button>
          </div>
        )}
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
            <EditableRow
              contact={contact}
              field="organizationName"
              label={t("contacts.fields.organizationName")}
              value={contact.organizationName}
            />
          )}
        </section>

        {/* Communication */}
        <section className="rounded-lg border p-4">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("contacts.communication.emails")} {"& "}
            {t("contacts.communication.phones")}
          </h2>
          <div className="space-y-3 text-sm">
            {primaryEmail && (
              <div className="flex items-center gap-2">
                <MailIcon className="text-muted-foreground size-4" />
                <span>{primaryEmail.address}</span>
                <span className="text-muted-foreground text-xs">
                  ({t(`contacts.emailTypes.${primaryEmail.type}`)})
                </span>
              </div>
            )}
            {contact.emails
              ?.filter((e) => e !== primaryEmail)
              .map((email) => (
                <div className="flex items-center gap-2" key={email.address}>
                  <MailIcon className="text-muted-foreground size-4" />
                  <span>{email.address}</span>
                  <span className="text-muted-foreground text-xs">
                    ({t(`contacts.emailTypes.${email.type}`)})
                  </span>
                </div>
              ))}
            {primaryPhone && (
              <div className="flex items-center gap-2">
                <PhoneIcon className="text-muted-foreground size-4" />
                <span>{primaryPhone.number}</span>
                <span className="text-muted-foreground text-xs">
                  ({t(`contacts.phoneTypes.${primaryPhone.type}`)})
                </span>
              </div>
            )}
            {contact.phones
              ?.filter((p) => p !== primaryPhone)
              .map((phone) => (
                <div className="flex items-center gap-2" key={phone.number}>
                  <PhoneIcon className="text-muted-foreground size-4" />
                  <span>{phone.number}</span>
                  <span className="text-muted-foreground text-xs">
                    ({t(`contacts.phoneTypes.${phone.type}`)})
                  </span>
                </div>
              ))}
            {!primaryEmail && !primaryPhone && (
              <p className="text-muted-foreground">
                {t("contacts.noContactsFound")}
              </p>
            )}
          </div>
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

        {/* Responsible attorneys */}
        {(contact.originatingAttorney ?? contact.responsibleAttorney) && (
          <section className="rounded-lg border p-4">
            <h2 className="text-muted-foreground mb-3 text-sm font-medium">
              {t("contacts.attorneys.title")}
            </h2>
            <div className="space-y-2 text-sm">
              {contact.originatingAttorney && (
                <InfoRow
                  label={t("contacts.attorneys.originating")}
                  value={contact.originatingAttorney.name}
                />
              )}
              {contact.responsibleAttorney && (
                <InfoRow
                  label={t("contacts.attorneys.responsible")}
                  value={contact.responsibleAttorney.name}
                />
              )}
            </div>
          </section>
        )}

        {/* Notes */}
        <section className="rounded-lg border p-4 md:col-span-2">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("common.notes")}
          </h2>
          <EditableRow
            contact={contact}
            field="notes"
            label=""
            value={contact.notes}
          />
        </section>

        {/* Matters as client */}
        <section className="rounded-lg border p-4 md:col-span-2">
          <h2 className="text-muted-foreground mb-3 text-sm font-medium">
            {t("contacts.mattersAsClient")}
          </h2>
          {contact.clientMatters.length > 0 ? (
            <ul className="space-y-2">
              {contact.clientMatters.map((matter) => (
                <li
                  className="hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors"
                  key={matter.id}
                >
                  <MatterColorIcon matter={matter} />
                  <Link
                    className="font-medium hover:underline"
                    params={{ workspaceId: matter.id }}
                    to="/workspaces/$workspaceId"
                  >
                    {matter.name}
                  </Link>
                  <span className="text-muted-foreground ms-auto text-xs">
                    {t("common.createdAt", {
                      date: new Date(matter.createdAt).toLocaleDateString(),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("contacts.noMattersAsClient")}
            </p>
          )}
          {contact.partyCount > 0 && (
            <p className="text-muted-foreground mt-3 text-xs">
              {t("contacts.alsoPartyIn", {
                count: contact.partyCount,
              })}
            </p>
          )}
        </section>
      </div>

      {/* Delete confirmation */}
      <AlertDialog onOpenChange={setIsDeleteOpen} open={isDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("contacts.deleteContact")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("contacts.deleteContactConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={<Button onClick={handleDelete} variant="destructive" />}
            >
              {t("common.delete")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

// Read-only row for non-editable fields
const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline gap-2">
    <span className="text-muted-foreground w-32 shrink-0">{label}</span>
    <span className="min-w-0 break-all">{value}</span>
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

type EditableRowProps = {
  label: string;
  value: string | null | undefined;
  field: EditableField;
  contact: ContactData;
  type?: "text" | "number";
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

  const handleSave = () => {
    setIsEditing(false);
    const trimmed = inputValue.trim();
    const current = value ?? "";

    if (trimmed === current) {
      return;
    }

    let payload: Record<string, unknown>;
    if (field === "defaultHourlyRate" || field === "paymentTermDays") {
      const parsed = trimmed ? Number.parseInt(trimmed, 10) : null;
      payload = {
        [field]: parsed !== null && !Number.isNaN(parsed) ? parsed : null,
      };
    } else {
      payload = { [field]: trimmed || null };
    }

    updateContact.mutate(
      { contactId: contact.id, ...payload },
      {
        onSuccess: () => {
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: contactsKeys.byId(contact.id),
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: contactsKeys.list(),
          });
        },
        onError: () => {
          toastManager.add({
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

const MatterColorIcon = ({
  matter,
}: {
  matter: { id: string; color: string | null };
}) => {
  const updateWorkspace = useUpdateWorkspace();
  const activeColor = matter.color
    ? `var(${matter.color})`
    : `var(${getMatterSwatch(matter.id)})`;

  return (
    <Popover>
      <PopoverTrigger
        className="hover:bg-muted cursor-pointer rounded p-0.5 transition-colors"
        render={<button type="button" />}
      >
        <LayersIcon
          className="size-4 shrink-0"
          style={{ color: activeColor }}
        />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-auto" sideOffset={8}>
        <div className="flex gap-1.5">
          {MATTER_SWATCHES.map((swatch) => (
            <button
              className="size-5 rounded-full transition-transform hover:scale-125"
              key={swatch}
              onClick={() => {
                updateWorkspace.mutate({
                  workspaceId: matter.id,
                  color: swatch,
                });
              }}
              style={{
                backgroundColor: `var(${swatch})`,
              }}
              type="button"
            />
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
};
