import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import { MatterIcon } from "@stll/ui/matter-icon";
import { stellaToast } from "@stll/ui/toast";

import { DetailRows, DetailSection } from "@/components/detail-section.pending";
import { MatterRefLink } from "@/components/matter-ref-link";
import { RouteDocumentTitle } from "@/components/route-document-title";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useDeleteContact } from "@/lib/contacts/mutations";
import { contactOptions, contactsKeys } from "@/lib/contacts/queries";
import { detached } from "@/lib/detached";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { ClientInvoiceComposer } from "@/routes/_protected.contacts/-components/client-invoice-composer";
import { ContactCommunicationEditor } from "@/routes/_protected.contacts/-components/contact-communication-editor";
import { ContactCustomFieldsEditor } from "@/routes/_protected.contacts/-components/contact-custom-fields-editor";
import { ContactNotesEditor } from "@/routes/_protected.contacts/-components/contact-notes-editor";
import { ContactOwnersEditor } from "@/routes/_protected.contacts/-components/contact-owners-editor";
import { ContactPersonDetailsEditor } from "@/routes/_protected.contacts/-components/contact-person-details-editor";
import { EditableRow } from "@/routes/_protected.contacts/-components/editable-row";
import { InfoRow } from "@/routes/_protected.contacts/-components/info-row";
import { PartyMatterRow } from "@/routes/_protected.contacts/-components/party-matter-row";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";
import { VatPayerSelect } from "@/routes/_protected.contacts/-components/vat-payer-select";

import {
  CONTACT_IDENTITY_FIELDS,
  CONTACT_TYPE_LABEL_KEYS,
  CONTACT_WIDE_SECTION_CLASS,
  ContactDetailHeader,
  contactDetailSections,
  ContactDetailShell,
  ContactTypeIcon,
  DELETE_CONTACT_BUTTON,
  NEW_MATTER_BUTTON,
  NewMatterButtonContent,
} from "./-contact-detail.pending";
import type { ContactDetailSection } from "./-contact-detail.pending";

const CONTACT_ROUTE_ID = "/_protected/contacts/$contactId";

const routeApi = getRouteApi(CONTACT_ROUTE_ID);
const protectedRouteApi = getRouteApi("/_protected");

const IdentitySection = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  return (
    <DetailSection title={t(CONTACT_TYPE_LABEL_KEYS[contact.type])}>
      <DetailRows>
        {CONTACT_IDENTITY_FIELDS[contact.type].map(({ field, labelKey }) => (
          <EditableRow
            contact={contact}
            field={field}
            key={field}
            label={t(labelKey)}
            value={contact[field]}
          />
        ))}
      </DetailRows>
    </DetailSection>
  );
};

const BillingAddress = ({
  address,
}: {
  address: NonNullable<ContactData["billingAddress"]>;
}) => {
  const t = useTranslations();
  return (
    <div className="min-w-0 rounded-md border p-2">
      <p className="text-muted-foreground mb-1 text-xs font-medium">
        {t("contacts.fields.billingAddress")}
      </p>
      {address.line1 && (
        <InfoRow
          label={t("contacts.fields.billingAddressLine1")}
          value={address.line1}
        />
      )}
      {address.line2 && (
        <InfoRow
          label={t("contacts.fields.billingAddressLine2")}
          value={address.line2}
        />
      )}
      {address.city && (
        <InfoRow
          label={t("contacts.fields.billingAddressCity")}
          value={address.city}
        />
      )}
      {address.postalCode && (
        <InfoRow
          label={t("contacts.fields.billingAddressPostalCode")}
          value={address.postalCode}
        />
      )}
      {address.state && (
        <InfoRow
          label={t("contacts.fields.billingAddressState")}
          value={address.state}
        />
      )}
      {address.country && (
        <InfoRow label={t("common.country")} value={address.country} />
      )}
    </div>
  );
};

const BillingSection = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const canReadBilling = usePermissions({ billing: ["read"] });
  return (
    <DetailSection title={t("contacts.billing.title")}>
      <DetailRows>
        <EditableRow
          contact={contact}
          field="registrationNumber"
          label={t("contacts.fields.registrationNumber")}
          value={contact.registrationNumber}
        />
        <EditableRow
          contact={contact}
          field="taxId"
          label={t("common.taxId")}
          value={contact.taxId}
        />
        <EditableRow
          contact={contact}
          field="vatId"
          label={t("common.vatId")}
          value={contact.vatId}
        />
        <VatPayerSelect contact={contact} />
        {canReadBilling && (
          <EditableRow
            // A draft is typed in one currency's units; a currency change
            // remounts the row; its commit guard discards the old draft.
            key={`default-hourly-rate-${contact.currency ?? "none"}`}
            contact={contact}
            field="defaultHourlyRate"
            label={t("contacts.fields.defaultHourlyRate")}
          />
        )}
        {canReadBilling && (
          <EditableRow
            contact={contact}
            field="currency"
            label={t("common.currency")}
            value={contact.currency}
          />
        )}
        <EditableRow
          contact={contact}
          field="paymentTermDays"
          label={t("contacts.fields.paymentTermDays")}
          value={
            contact.paymentTermDays !== null
              ? String(contact.paymentTermDays)
              : null
          }
        />
        {contact.billingAddress && (
          <BillingAddress address={contact.billingAddress} />
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
      </DetailRows>
    </DetailSection>
  );
};

const MattersSection = ({ contact }: { contact: ContactData }) => {
  const t = useTranslations();
  const format = useFormatter();
  const activeClientMatters = contact.clientMatters;
  return (
    <DetailSection
      className={CONTACT_WIDE_SECTION_CLASS}
      title={t("contacts.mattersAsClient")}
    >
      {activeClientMatters.length > 0 ? (
        <ul className="space-y-2">
          {activeClientMatters.map((matter) => (
            <li key={matter.id}>
              <MatterRefLink
                className="hover:bg-muted flex items-center gap-2 rounded-md px-3 py-2 text-sm"
                workspaceId={matter.id}
              >
                <MatterIcon className="size-4 shrink-0" matter={matter} />
                <BidiText as="span" className="font-medium">
                  {matter.name}
                </BidiText>
                <span className="text-muted-foreground ms-auto text-xs">
                  {t("common.createdAt", {
                    date: format.dateTime(new Date(matter.createdAt).getTime()),
                  })}
                </span>
              </MatterRefLink>
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
    </DetailSection>
  );
};

/** One of the contact's sections, in the place the shared order gives it. */
const ContactSection = ({
  contact,
  section,
}: {
  contact: ContactData;
  section: ContactDetailSection;
}) => {
  const t = useTranslations();
  switch (section) {
    case "identity":
      return <IdentitySection contact={contact} />;
    case "personalDetails":
      return <ContactPersonDetailsEditor contact={contact} />;
    case "communication":
      return (
        <DetailSection title={t("contacts.communication.title")}>
          <ContactCommunicationEditor contact={contact} />
        </DetailSection>
      );
    case "billing":
      return <BillingSection contact={contact} />;
    case "owners":
      return <ContactOwnersEditor contact={contact} />;
    case "customFields":
      return <ContactCustomFieldsEditor contact={contact} />;
    case "notes":
      return (
        <DetailSection
          className={CONTACT_WIDE_SECTION_CLASS}
          title={t("common.notes")}
        >
          <ContactNotesEditor contact={contact} />
        </DetailSection>
      );
    case "matters":
      return <MattersSection contact={contact} />;
    default:
      section satisfies never;
      return panic(`Unhandled contact section: ${String(section)}`);
  }
};

/** /contacts/$contactId: one contact, edited in place. */
export function ContactDetailPage() {
  const t = useTranslations();
  const contactId = routeApi.useParams({ select: (p) => p.contactId });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: contact } = useSuspenseQuery(
    contactOptions(activeOrganizationId, contactId),
  );
  const deleteContact = useDeleteContact();
  const [invoiceComposerOpen, setInvoiceComposerOpen] = useState(false);
  const canCreateInvoice = usePermissions({
    invoice: ["create"],
    billing: ["read"],
  });
  const canCreateMatter = usePermissions({ workspace: ["create"] });
  const canDeleteContact = usePermissions({ contact: ["delete"] });
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const deleteBlockedDescription = t("contacts.deleteContactBlockedByMatters");

  const handleDelete = async () => {
    await deleteContact.mutateAsync(
      { contactId },
      {
        onSuccess: () => {
          detached(
            (async () => {
              stellaToast.add({
                title: t("success.contactDeleted"),
                type: "success",
              });
              await queryClient.invalidateQueries({
                queryKey: contactsKeys.all,
              });
              await navigate({ to: "/contacts" });
            })(),
            "contacts.add",
          );
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  const handleDeleteOpen = () => {
    if (contact.clientMatterCount > 0) {
      notifyUserProblem(deleteBlockedDescription);
      return;
    }

    setIsDeleteOpen(true);
  };

  return (
    <>
      <RouteDocumentTitle
        routeId={CONTACT_ROUTE_ID}
        title={contact.displayName}
      />
      <ContactDetailShell
        header={
          <ContactDetailHeader
            actions={
              <>
                {canCreateInvoice && contact.clientMatters.length > 0 && (
                  <Button
                    size="sm"
                    onClick={() => setInvoiceComposerOpen(true)}
                  >
                    {t("billing.clientComposer.title")}
                  </Button>
                )}
                {canCreateMatter && (
                  <Button
                    onClick={(event) =>
                      openCreateMatter({
                        opener: event.currentTarget,
                        client: {
                          id: contact.id,
                          displayName: contact.displayName,
                          type: contact.type,
                        },
                      })
                    }
                    size={NEW_MATTER_BUTTON.size}
                    variant={NEW_MATTER_BUTTON.variant}
                  >
                    <NewMatterButtonContent label={t("common.newMatter")} />
                  </Button>
                )}
                {canDeleteContact && (
                  <Button
                    disabled={deleteContact.isPending}
                    onClick={handleDeleteOpen}
                    size={DELETE_CONTACT_BUTTON.size}
                    variant={DELETE_CONTACT_BUTTON.variant}
                  >
                    {t("contacts.deleteContact")}
                  </Button>
                )}
              </>
            }
            badge={t(CONTACT_TYPE_LABEL_KEYS[contact.type])}
            icon={<ContactTypeIcon type={contact.type} />}
            name={<BidiText>{contact.displayName}</BidiText>}
          />
        }
      >
        {contactDetailSections(contact.type).map((section) => (
          <ContactSection contact={contact} key={section} section={section} />
        ))}
      </ContactDetailShell>

      {canCreateInvoice && (
        <ClientInvoiceComposer
          clientId={contactId}
          clientName={contact.displayName}
          open={invoiceComposerOpen}
          onOpenChange={setInvoiceComposerOpen}
        />
      )}
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
    </>
  );
}
