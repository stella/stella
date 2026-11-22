import type { ReactNode } from "react";

import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type {
  CertifiedEmailEnvelope,
  CertifiedEmailError,
  CertifiedEmailKind,
  CertifiedEmailReceiptType,
} from "@stll/api-contract/certified-email";
import type { EmailReading as EmailReadingData } from "@stll/api-contract/email-reading";
import { Text } from "@stll/ui/text";

import { parseEmailDate } from "@/components/email-reading.logic";
import { FilePartList } from "@/components/file-part-list";
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

const Lines = ({ lines }: { lines: readonly string[] }) => (
  <>
    {keyedBy(lines, (line) => line).map(({ item, key }) => (
      <Text key={key} selectable>
        {item}
      </Text>
    ))}
  </>
);

/**
 * The certification data a certified email's provider states (Italian PEC),
 * shown in the envelope where a plain email shows its header's sender,
 * recipients and date. The provider's signature is shown as found, never
 * verified.
 */
const CertificationFields = ({
  copies,
  envelope,
}: {
  /** The message header's copies, shown after the stated recipients. */
  copies: ReactNode;
  envelope: CertifiedEmailEnvelope;
}) => {
  const t = useTranslations("certifiedEmail");
  const format = useFormatter();
  const errorKey = ERROR_KEYS[envelope.error];
  const deliveryKey = DELIVERY_LABEL_KEYS[envelope.kind];
  return (
    <>
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
      {copies}
      {deliveryKey !== null && envelope.deliveredTo && (
        <Field label={t(deliveryKey)}>
          <Text selectable>{envelope.deliveredTo}</Text>
        </Field>
      )}
      {envelope.receivedFor.length > 0 && (
        <Field label={t("handedOverFor")}>
          <Lines lines={envelope.receivedFor} />
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
      <Text variant="caption">
        {envelope.signature.signerName
          ? `${t("signedBy", { name: envelope.signature.signerName })}\n`
          : ""}
        {t("signatureNotVerified")}
      </Text>
    </>
  );
};

/**
 * An email file as the web shows it: its envelope, its text and its
 * attachments in the list every file inside a file uses. A plain email's
 * envelope is its header (subject, sender, recipients, copies, date); a
 * certified email (Italian PEC) heads it with what the provider's message is
 * and states the provider's certification data in place of the header's
 * sender, recipients and date.
 */
export const EmailReading = ({
  read: { attachments, cc, certified, date, from, subject, text, to },
}: {
  read: EmailReadingData;
}) => {
  const t = useTranslations("email");
  const pec = useTranslations("certifiedEmail");
  const format = useFormatter();
  const subjectText = subject?.trim() ? subject : t("noSubject");
  const sentAt = parseEmailDate(date);
  const copies =
    cc.length > 0 ? (
      <Field label={t("cc")}>
        <Lines lines={cc} />
      </Field>
    ) : null;
  return (
    <>
      <Text accessibilityRole="header" selectable variant="headline">
        {certified === null
          ? subjectText
          : pec(KIND_TITLE_KEYS[certified.kind])}
      </Text>
      {certified === null ? (
        <>
          {from ? (
            <Field label={t("from")}>
              <Text selectable>{from}</Text>
            </Field>
          ) : null}
          {to.length > 0 && (
            <Field label={t("to")}>
              <Lines lines={to} />
            </Field>
          )}
          {copies}
          {date !== null && date.trim() !== "" && (
            <Field label={t("date")}>
              <Text selectable>
                {sentAt === null
                  ? date
                  : format.dateTime(sentAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
              </Text>
            </Field>
          )}
        </>
      ) : (
        <>
          <Text variant="caption">{pec("statedInFile")}</Text>
          {!certified.includesOriginal && (
            <Text variant="caption">{pec("originalNotIncluded")}</Text>
          )}
          <Field label={t("subject")}>
            <Text selectable>{subjectText}</Text>
          </Field>
          <CertificationFields copies={copies} envelope={certified} />
        </>
      )}
      {text.trim() ? <Text selectable>{text}</Text> : null}
      <FilePartList items={attachments} />
    </>
  );
};
