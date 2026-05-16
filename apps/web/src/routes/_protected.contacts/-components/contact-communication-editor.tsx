import type { ReactNode } from "react";
import { useState } from "react";

import { InboxIcon, MailIcon, PhoneIcon, Trash2Icon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { AddContactMethodForm } from "@/routes/_protected.contacts/-components/add-contact-method-form";
import { useContactPatch } from "@/routes/_protected.contacts/-components/contact-caches";
import {
  DATA_BOX_ID_PATTERN,
  EMAIL_SCHEMA,
  getContactMetadata,
} from "@/routes/_protected.contacts/-components/contact-metadata";
import { EmailLink } from "@/routes/_protected.contacts/-components/email-link";
import type { ContactData } from "@/routes/_protected.contacts/-components/types";

export const ContactCommunicationEditor = ({
  contact,
}: {
  contact: ContactData;
}) => {
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
