import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, BuildingIcon, PlusIcon, UserIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { ContactCommunicationEditor } from "@/routes/_protected.contacts/-components/contact-communication-editor";
import { ContactCustomFieldsEditor } from "@/routes/_protected.contacts/-components/contact-custom-fields-editor";
import { ContactNotesEditor } from "@/routes/_protected.contacts/-components/contact-notes-editor";
import { ContactOwnersEditor } from "@/routes/_protected.contacts/-components/contact-owners-editor";
import { EditableRow } from "@/routes/_protected.contacts/-components/editable-row";
import { InfoRow } from "@/routes/_protected.contacts/-components/info-row";
import {
  MatterIcon,
  PartyMatterRow,
} from "@/routes/_protected.contacts/-components/party-matter-row";
import { useDeleteContact } from "@/routes/_protected.contacts/-mutations";
import {
  contactOptions,
  contactsKeys,
} from "@/routes/_protected.contacts/-queries";
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
