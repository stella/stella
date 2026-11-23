import type {
  CertifiedEmailEnvelope as Envelope,
  CertifiedEmailError,
  CertifiedEmailKind,
  CertifiedEmailReceiptType,
} from "@stll/api-contract/certified-email";

import { useFormatter } from "@/i18n/formatting-context";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

import { EnvelopeCard, EnvelopeField as Field } from "../envelope-field";
import {
  certifiedEmailCatalog,
  type CertifiedEmailTranslationKey,
} from "./certified-email-catalog";

const KIND_TITLE_KEYS = {
  transport: "certifiedEmail.kinds.transport",
  acceptance: "certifiedEmail.kinds.acceptance",
  non_acceptance: "certifiedEmail.kinds.nonAcceptance",
  taken_in_charge: "certifiedEmail.kinds.takenInCharge",
  delivery: "certifiedEmail.kinds.delivery",
  delivery_error: "certifiedEmail.kinds.deliveryError",
  delivery_error_warning: "certifiedEmail.kinds.deliveryErrorWarning",
  virus_detected: "certifiedEmail.kinds.virusDetected",
} as const satisfies Record<CertifiedEmailKind, CertifiedEmailTranslationKey>;

const ERROR_KEYS = {
  none: null,
  no_recipient: "certifiedEmail.errors.noRecipient",
  no_domain: "certifiedEmail.errors.noDomain",
  virus: "certifiedEmail.errors.virus",
  other: "certifiedEmail.errors.other",
} as const satisfies Record<
  CertifiedEmailError,
  CertifiedEmailTranslationKey | null
>;

const RECEIPT_TYPE_KEYS = {
  full: "certifiedEmail.receiptTypes.full",
  short: "certifiedEmail.receiptTypes.short",
  summary: "certifiedEmail.receiptTypes.summary",
} as const satisfies Record<
  CertifiedEmailReceiptType,
  CertifiedEmailTranslationKey
>;

/** The mailbox a receipt or notice is about was reached, or was not. */
const DELIVERY_LABEL_KEYS = {
  transport: null,
  acceptance: null,
  non_acceptance: null,
  taken_in_charge: null,
  delivery: "certifiedEmail.deliveredTo",
  delivery_error: "certifiedEmail.notDeliveredTo",
  delivery_error_warning: "certifiedEmail.notDeliveredTo",
  virus_detected: "certifiedEmail.notDeliveredTo",
} as const satisfies Record<
  CertifiedEmailKind,
  CertifiedEmailTranslationKey | null
>;

/** An address can repeat (as To and as Cc); its nth listing keeps its key. */
const keyedByOccurrence = <TItem,>(
  items: readonly TItem[],
  address: (item: TItem) => string,
) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const value = address(item);
    const occurrence = (seen.get(value) ?? 0) + 1;
    seen.set(value, occurrence);
    return { item, key: `${value}#${String(occurrence)}` };
  });
};

const Address = ({ children }: { children: string }) => (
  <bdi className="font-mono text-xs" dir="ltr">
    {children}
  </bdi>
);

/** The provider's signature is shown as found, never verified. */
const EnvelopeSection = ({ envelope }: { envelope: Envelope }) => {
  const t = certifiedEmailCatalog.useTranslations();
  const format = useFormatter();
  const errorKey = ERROR_KEYS[envelope.error];
  const deliveryKey = DELIVERY_LABEL_KEYS[envelope.kind];
  const { signerName } = envelope.signature;

  return (
    <EnvelopeCard>
      <div className="col-span-full space-y-1">
        <h2 className="text-sm font-medium">
          {t(KIND_TITLE_KEYS[envelope.kind])}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("certifiedEmail.statedInFile")}
        </p>
        {!envelope.includesOriginal && (
          <p className="text-muted-foreground text-xs">
            {t("certifiedEmail.originalNotIncluded")}
          </p>
        )}
      </div>
      {envelope.sender && (
        <Field label={t("certifiedEmail.sender")}>
          <Address>{envelope.sender}</Address>
        </Field>
      )}
      {envelope.recipients.length > 0 && (
        <Field label={t("certifiedEmail.recipients")}>
          <ul className="space-y-0.5">
            {keyedByOccurrence(
              envelope.recipients,
              ({ address }) => address,
            ).map(({ item: { address, certified }, key }) => (
              <li className="flex flex-wrap items-baseline gap-x-2" key={key}>
                <Address>{address}</Address>
                {!certified && (
                  <span className="text-muted-foreground text-xs">
                    {t("certifiedEmail.ordinaryMailbox")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Field>
      )}
      {deliveryKey !== null && envelope.deliveredTo && (
        <Field label={t(deliveryKey)}>
          <Address>{envelope.deliveredTo}</Address>
        </Field>
      )}
      {envelope.receivedFor.length > 0 && (
        <Field label={t("certifiedEmail.handedOverFor")}>
          <ul className="space-y-0.5">
            {keyedByOccurrence(envelope.receivedFor, (address) => address).map(
              ({ item: address, key }) => (
                <li key={key}>
                  <Address>{address}</Address>
                </li>
              ),
            )}
          </ul>
        </Field>
      )}
      {envelope.certifiedAt && (
        <Field label={t("certifiedEmail.certifiedAt")}>
          <time dateTime={envelope.certifiedAt}>
            {format.dateTime(
              new Date(envelope.certifiedAt),
              MEDIUM_DATE_SHORT_TIME_FORMAT,
            )}
          </time>
        </Field>
      )}
      {errorKey !== null && (
        <Field label={t("certifiedEmail.error")}>
          {t(errorKey)}
          {envelope.errorDetail && (
            <span className="text-muted-foreground mt-0.5 block text-xs">
              <bdi dir="auto">{envelope.errorDetail}</bdi>
            </span>
          )}
        </Field>
      )}
      {envelope.provider && (
        <Field label={t("certifiedEmail.provider")}>
          <bdi dir="auto">{envelope.provider}</bdi>
        </Field>
      )}
      {envelope.receiptType && (
        <Field label={t("certifiedEmail.receipt")}>
          {t(RECEIPT_TYPE_KEYS[envelope.receiptType])}
        </Field>
      )}
      {envelope.messageId && (
        <Field label={t("certifiedEmail.messageId")}>
          <Address>{envelope.messageId}</Address>
        </Field>
      )}
      <p className="text-muted-foreground col-span-full text-xs">
        {signerName && (
          <span className="block">
            <bdi dir="auto">
              {t("certifiedEmail.signedBy", {
                name: signerName,
              })}
            </bdi>
          </span>
        )}
        {t("certifiedEmail.signatureNotVerified")}
      </p>
    </EnvelopeCard>
  );
};

/**
 * A certified email's certification data as its provider states it: what
 * the message is, who sent it to whom, when it was certified and with what
 * outcome. Its strings load with it; nothing shows until they have.
 */
export const CertifiedEmailEnvelope = ({
  envelope,
}: {
  envelope: Envelope;
}) => (
  <certifiedEmailCatalog.Provider fallback={null}>
    <EnvelopeSection envelope={envelope} />
  </certifiedEmailCatalog.Provider>
);
