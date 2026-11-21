import type { ReactNode } from "react";

import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type {
  CertifiedEmailError,
  CertifiedEmailKind,
  CertifiedEmailRead,
  CertifiedEmailReceiptType,
} from "@stll/api-contract/certified-email";
import { Text } from "@stll/ui/text";

import { keyedBy } from "@/components/keyed";

const KIND_TITLE_KEYS = {
  transport: "kinds.transport",
  acceptance: "kinds.acceptance",
  non_acceptance: "kinds.nonAcceptance",
  taken_in_charge: "kinds.takenInCharge",
  delivery: "kinds.delivery",
  delivery_error: "kinds.deliveryError",
  delivery_error_warning: "kinds.deliveryErrorWarning",
  virus_detected: "kinds.virusDetected",
} as const satisfies Record<CertifiedEmailKind, string>;

const ERROR_KEYS = {
  none: null,
  no_recipient: "errors.noRecipient",
  no_domain: "errors.noDomain",
  virus: "errors.virus",
  other: "errors.other",
} as const satisfies Record<CertifiedEmailError, string | null>;

const RECEIPT_TYPE_KEYS = {
  full: "receiptTypes.full",
  short: "receiptTypes.short",
  summary: "receiptTypes.summary",
} as const satisfies Record<CertifiedEmailReceiptType, string>;

const DELIVERY_LABEL_KEYS = {
  transport: null,
  acceptance: null,
  non_acceptance: null,
  taken_in_charge: null,
  delivery: "deliveredTo",
  delivery_error: "notDeliveredTo",
  delivery_error_warning: "notDeliveredTo",
  virus_detected: "notDeliveredTo",
} as const satisfies Record<CertifiedEmailKind, string | null>;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <View>
    <Text accessibilityRole="header" variant="label">
      {label}
    </Text>
    {children}
  </View>
);

/**
 * A certified email (Italian PEC) as the web shows it: the provider's
 * certification data, the original message's text and its attachments. The
 * provider's signature is shown as found, never verified.
 */
export const CertifiedEmailReading = ({
  read: { envelope, text, attachments },
}: {
  read: CertifiedEmailRead;
}) => {
  const t = useTranslations("certifiedEmail");
  const chat = useTranslations("chat");
  const format = useFormatter();
  const errorKey = ERROR_KEYS[envelope.error];
  const deliveryKey = DELIVERY_LABEL_KEYS[envelope.kind];
  const signerName = envelope.signature?.signerName ?? null;
  return (
    <>
      <Text accessibilityRole="header" variant="headline">
        {t(KIND_TITLE_KEYS[envelope.kind])}
      </Text>
      {!envelope.includesOriginal && (
        <Text variant="caption">{t("originalNotIncluded")}</Text>
      )}
      {envelope.sender && (
        <Field label={t("sender")}>
          <Text selectable>{envelope.sender}</Text>
        </Field>
      )}
      {envelope.recipients.length > 0 && (
        <Field label={t("recipients")}>
          {keyedBy(envelope.recipients, ({ address }) => address).map(
            ({ item: { address, certified }, key }) => (
              <Text key={key} selectable>
                {address}
                {certified ? null : (
                  <Text variant="caption">{` · ${t("ordinaryMailbox")}`}</Text>
                )}
              </Text>
            ),
          )}
        </Field>
      )}
      {deliveryKey !== null && envelope.deliveredTo && (
        <Field label={t(deliveryKey)}>
          <Text selectable>{envelope.deliveredTo}</Text>
        </Field>
      )}
      {envelope.receivedFor.length > 0 && (
        <Field label={t("handedOverFor")}>
          {keyedBy(envelope.receivedFor, (address) => address).map(
            ({ item, key }) => (
              <Text key={key} selectable>
                {item}
              </Text>
            ),
          )}
        </Field>
      )}
      {envelope.certifiedAt && (
        <Field label={t("certifiedAt")}>
          <Text>
            {format.dateTime(new Date(envelope.certifiedAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </Text>
        </Field>
      )}
      {errorKey !== null && (
        <Field label={t("error")}>
          <Text>{t(errorKey)}</Text>
          {envelope.errorDetail && (
            <Text selectable variant="caption">
              {envelope.errorDetail}
            </Text>
          )}
        </Field>
      )}
      {envelope.provider && (
        <Field label={t("provider")}>
          <Text selectable>{envelope.provider}</Text>
        </Field>
      )}
      {envelope.receiptType && (
        <Field label={t("receipt")}>
          <Text>{t(RECEIPT_TYPE_KEYS[envelope.receiptType])}</Text>
        </Field>
      )}
      {envelope.messageId && (
        <Field label={t("messageId")}>
          <Text selectable>{envelope.messageId}</Text>
        </Field>
      )}
      {envelope.signature !== null && (
        <Text variant="caption">
          {signerName ? `${t("signedBy", { name: signerName })}\n` : ""}
          {t("signatureNotVerified")}
        </Text>
      )}
      {text.trim() ? <Text selectable>{text}</Text> : null}
      {attachments.length > 0 && (
        <Field label={t("attachments")}>
          {keyedBy(attachments, ({ fileName }) => fileName ?? "").map(
            ({ item: { fileName, sizeBytes }, key }) => (
              <Text key={key} selectable>
                {fileName ?? chat("attachment")}
                <Text variant="caption">{` · ${format.number(sizeBytes, {
                  style: "unit",
                  unit: "byte",
                  unitDisplay: "short",
                })}`}</Text>
              </Text>
            ),
          )}
        </Field>
      )}
    </>
  );
};
