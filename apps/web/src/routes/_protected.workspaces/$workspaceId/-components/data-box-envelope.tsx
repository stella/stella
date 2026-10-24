import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type {
  CorrespondenceDataBoxContactMatches,
  CorrespondenceDataBoxContacts,
} from "@stll/api-contract/correspondence";
import type {
  DataBoxEnvelope as Envelope,
  DataBoxMessageStatus,
  DataBoxParty,
} from "@stll/api-contract/data-box";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

const ACCEPTANCE_LABEL_KEYS = {
  accepted_by_fiction: "correspondence.dataBox.acceptedByFiction",
  accepted_by_login: "correspondence.dataBox.acceptedByLogin",
} as const satisfies Record<
  Extract<DataBoxMessageStatus, "accepted_by_fiction" | "accepted_by_login">,
  TranslationKey
>;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0 space-y-1">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="text-sm wrap-break-word">{children}</div>
  </div>
);

const Party = ({
  party,
  contacts,
}: {
  party: DataBoxParty;
  contacts: CorrespondenceDataBoxContactMatches;
}) => {
  const t = useTranslations();
  return (
    <span className="flex flex-col gap-0.5">
      {party.name && <bdi dir="auto">{party.name}</bdi>}
      <bdi className="text-muted-foreground font-mono text-xs" dir="ltr">
        {party.boxId}
      </bdi>
      {contacts.matches.map((contact) => (
        <Link
          className="text-xs underline-offset-2 hover:underline"
          key={contact.contactId}
          params={{ contactId: contact.contactId }}
          to="/contacts/$contactId"
        >
          <bdi dir="auto">
            {t("correspondence.dataBox.contact", { name: contact.displayName })}
          </bdi>
        </Link>
      ))}
      {contacts.hasMore && (
        <span className="text-muted-foreground text-xs">
          {t("correspondence.dataBox.moreContacts")}
        </span>
      )}
    </span>
  );
};

const references = (party: DataBoxParty) =>
  [party.referenceNumber, party.fileMark].filter((value) => value !== null);

/**
 * A data-box message's envelope as stated in its `.zfo` file, with the
 * contacts whose data boxes list the sender or recipient box.
 */
export const DataBoxEnvelope = ({
  envelope,
  contacts,
}: {
  envelope: Envelope;
  contacts: CorrespondenceDataBoxContacts | null;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const formatTime = (value: string) =>
    format.dateTime(new Date(value), MEDIUM_DATE_SHORT_TIME_FORMAT);
  const acceptance =
    envelope.status === "accepted_by_fiction" ||
    envelope.status === "accepted_by_login"
      ? ACCEPTANCE_LABEL_KEYS[envelope.status]
      : null;
  if (contacts === null) {
    return panic("Data-box correspondence is missing contact matches");
  }
  const senderReferences = references(envelope.sender);
  const recipientReferences = references(envelope.recipient);

  return (
    <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <h2 className="text-sm font-medium">
          {t("correspondence.dataBox.statedInFile")}
        </h2>
        {envelope.directionBasis !== "organization_recipient" && (
          <p className="text-muted-foreground text-xs">
            {t(
              envelope.directionBasis === "organization_sender"
                ? "correspondence.dataBox.sent"
                : "correspondence.dataBox.directionUnknown",
            )}
          </p>
        )}
      </div>
      <Field label={t("emailViewer.from")}>
        <Party contacts={contacts.sender} party={envelope.sender} />
      </Field>
      <Field label={t("correspondence.dataBox.recipient")}>
        <Party contacts={contacts.recipient} party={envelope.recipient} />
        {envelope.toHands && (
          <span className="text-muted-foreground mt-1 block text-xs">
            <bdi dir="auto">
              {t("correspondence.dataBox.toHands", { name: envelope.toHands })}
            </bdi>
          </span>
        )}
      </Field>
      {senderReferences.length > 0 && (
        <Field label={t("correspondence.dataBox.senderReference")}>
          <bdi dir="auto">{senderReferences.join(" · ")}</bdi>
        </Field>
      )}
      {recipientReferences.length > 0 && (
        <Field label={t("correspondence.dataBox.recipientReference")}>
          <bdi dir="auto">{recipientReferences.join(" · ")}</bdi>
        </Field>
      )}
      {envelope.deliveredAt && (
        <Field label={t("correspondence.dataBox.deliveredAt")}>
          {formatTime(envelope.deliveredAt)}
        </Field>
      )}
      {envelope.acceptedAt && (
        <Field label={t("correspondence.dataBox.acceptedAt")}>
          {formatTime(envelope.acceptedAt)}
          {acceptance && (
            <span className="text-muted-foreground ms-2 text-xs">
              {t(acceptance)}
            </span>
          )}
        </Field>
      )}
      <Field label={t("correspondence.dataBox.messageId")}>
        <bdi className="font-mono" dir="ltr">
          {envelope.messageId}
        </bdi>
      </Field>
      {envelope.personalDelivery === true && (
        <Field label={t("correspondence.dataBox.delivery")}>
          {t("correspondence.dataBox.personalDelivery")}
        </Field>
      )}
    </section>
  );
};
