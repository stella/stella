import { useTranslations } from "use-intl";

import type {
  CertifiedEmailEnvelope as Envelope,
  CertifiedEmailError,
  CertifiedEmailKind,
  CertifiedEmailReceiptType,
} from "@stll/api-contract/certified-email";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";

import { EnvelopeField as Field } from "./envelope-field";

const KIND_TITLE_KEYS = {
  transport: "correspondence.certifiedEmail.kinds.transport",
  acceptance: "correspondence.certifiedEmail.kinds.acceptance",
  non_acceptance: "correspondence.certifiedEmail.kinds.nonAcceptance",
  taken_in_charge: "correspondence.certifiedEmail.kinds.takenInCharge",
  delivery: "correspondence.certifiedEmail.kinds.delivery",
  delivery_error: "correspondence.certifiedEmail.kinds.deliveryError",
  delivery_error_warning:
    "correspondence.certifiedEmail.kinds.deliveryErrorWarning",
  virus_detected: "correspondence.certifiedEmail.kinds.virusDetected",
} as const satisfies Record<CertifiedEmailKind, TranslationKey>;

const ERROR_KEYS = {
  none: null,
  no_recipient: "correspondence.certifiedEmail.errors.noRecipient",
  no_domain: "correspondence.certifiedEmail.errors.noDomain",
  virus: "correspondence.certifiedEmail.errors.virus",
  other: "correspondence.certifiedEmail.errors.other",
} as const satisfies Record<CertifiedEmailError, TranslationKey | null>;

const RECEIPT_TYPE_KEYS = {
  full: "correspondence.certifiedEmail.receiptTypes.full",
  short: "correspondence.certifiedEmail.receiptTypes.short",
  summary: "correspondence.certifiedEmail.receiptTypes.summary",
} as const satisfies Record<CertifiedEmailReceiptType, TranslationKey>;

/** The mailbox a receipt or notice is about was reached, or was not. */
const DELIVERY_LABEL_KEYS = {
  transport: null,
  acceptance: null,
  non_acceptance: null,
  taken_in_charge: null,
  delivery: "correspondence.certifiedEmail.deliveredTo",
  delivery_error: "correspondence.certifiedEmail.notDeliveredTo",
  delivery_error_warning: "correspondence.certifiedEmail.notDeliveredTo",
  virus_detected: "correspondence.certifiedEmail.notDeliveredTo",
} as const satisfies Record<CertifiedEmailKind, TranslationKey | null>;

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

/**
 * A certified email's certification data as its provider states it: what
 * the message is, who sent it to whom, when it was certified and with what
 * outcome. The provider's signature is shown as found, never verified.
 */
export const CertifiedEmailEnvelope = ({
  envelope,
}: {
  envelope: Envelope;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const errorKey = ERROR_KEYS[envelope.error];
  const deliveryKey = DELIVERY_LABEL_KEYS[envelope.kind];
  const signerName = envelope.signature?.signerName ?? null;

  return (
    <section className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2">
        <h2 className="text-sm font-medium">
          {t(KIND_TITLE_KEYS[envelope.kind])}
        </h2>
        {!envelope.includesOriginal && (
          <p className="text-muted-foreground text-xs">
            {t("correspondence.certifiedEmail.originalNotIncluded")}
          </p>
        )}
      </div>
      {envelope.sender && (
        <Field label={t("correspondence.certifiedEmail.sender")}>
          <Address>{envelope.sender}</Address>
        </Field>
      )}
      {envelope.recipients.length > 0 && (
        <Field label={t("correspondence.certifiedEmail.recipients")}>
          <ul className="space-y-0.5">
            {keyedByOccurrence(
              envelope.recipients,
              ({ address }) => address,
            ).map(({ item: { address, certified }, key }) => (
              <li className="flex flex-wrap items-baseline gap-x-2" key={key}>
                <Address>{address}</Address>
                {!certified && (
                  <span className="text-muted-foreground text-xs">
                    {t("correspondence.certifiedEmail.ordinaryMailbox")}
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
        <Field label={t("correspondence.certifiedEmail.handedOverFor")}>
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
        <Field label={t("correspondence.certifiedEmail.certifiedAt")}>
          <time dateTime={envelope.certifiedAt}>
            {format.dateTime(
              new Date(envelope.certifiedAt),
              MEDIUM_DATE_SHORT_TIME_FORMAT,
            )}
          </time>
        </Field>
      )}
      {errorKey !== null && (
        <Field label={t("correspondence.certifiedEmail.error")}>
          {t(errorKey)}
          {envelope.errorDetail && (
            <span className="text-muted-foreground mt-0.5 block text-xs">
              <bdi dir="auto">{envelope.errorDetail}</bdi>
            </span>
          )}
        </Field>
      )}
      {envelope.provider && (
        <Field label={t("correspondence.certifiedEmail.provider")}>
          <bdi dir="auto">{envelope.provider}</bdi>
        </Field>
      )}
      {envelope.receiptType && (
        <Field label={t("correspondence.certifiedEmail.receipt")}>
          {t(RECEIPT_TYPE_KEYS[envelope.receiptType])}
        </Field>
      )}
      {envelope.messageId && (
        <Field label={t("correspondence.certifiedEmail.messageId")}>
          <Address>{envelope.messageId}</Address>
        </Field>
      )}
      {envelope.signature !== null && (
        <p className="text-muted-foreground text-xs sm:col-span-2">
          {signerName && (
            <span className="block">
              <bdi dir="auto">
                {t("correspondence.certifiedEmail.signedBy", {
                  name: signerName,
                })}
              </bdi>
            </span>
          )}
          {t("correspondence.certifiedEmail.signatureNotVerified")}
        </p>
      )}
    </section>
  );
};
