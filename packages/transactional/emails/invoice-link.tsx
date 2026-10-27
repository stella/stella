import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";

import { getEmailDirection, getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import { brand, BRAND_FOOTER_TEXT, sharedStyles } from "./_shared";

export type InvoiceLinkDocumentType = "invoice" | "advance" | "credit_note";

export type InvoiceLinkEmailProps = {
  lang: SupportedLang;
  documentType: InvoiceLinkDocumentType;
  invoiceNumber: string;
  firmName: string;
  /** The amount as the invoice prints it, or null when nothing is due. */
  amountDue: string | null;
  /** The due date as the invoice prints it, or null when it has none. */
  dueDate: string | null;
  /** The link's last valid day, formatted for the invoice language. */
  expiresOn: string;
  /** The sender's own note, shown as plain text. */
  message: string | null;
  link: string;
};

/**
 * One invoice delivered as a link: the email names the document and the firm
 * and carries no attachment; the recipient opens the invoice in stella.
 */
export const Email = ({
  lang,
  documentType,
  invoiceNumber,
  firmName,
  amountDue,
  dueDate,
  expiresOn,
  message,
  link,
}: InvoiceLinkEmailProps) => {
  const t = getTranslator(lang);
  const document = { documentType, invoiceNumber, firmName };

  return (
    <Html lang={lang} dir={getEmailDirection(lang)}>
      <Head />
      <Preview>{t("invoiceLink.preview", document)}</Preview>
      <Body style={sharedStyles.body}>
        <Container style={sharedStyles.container}>
          <Heading style={sharedStyles.heading}>
            {t("invoiceLink.heading", document)}
          </Heading>
          <Text style={sharedStyles.text}>
            {t("invoiceLink.body", document)}
          </Text>
          {amountDue === null ? null : (
            <Text style={styles["detail"]}>
              {t("invoiceLink.amountDue", { amount: amountDue })}
            </Text>
          )}
          {dueDate === null ? null : (
            <Text style={styles["detail"]}>
              {t("invoiceLink.dueDate", { date: dueDate })}
            </Text>
          )}
          {message === null ? null : (
            <Section style={styles["message"]}>
              <Text style={styles["messageHeading"]}>
                {t("invoiceLink.messageFrom", { firmName })}
              </Text>
              <Text style={styles["messageText"]}>{message}</Text>
            </Section>
          )}
          <Section style={styles["buttonSection"]}>
            <Button href={link} style={styles["button"]}>
              {t("invoiceLink.action", { documentType })}
            </Button>
          </Section>
          <Text style={sharedStyles.muted}>
            {t("invoiceLink.expires", { date: expiresOn })}
          </Text>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>
            {t("invoiceLink.reply", { firmName })}
          </Text>
          <Text style={sharedStyles.footer}>
            {t("invoiceLink.ignore", { firmName })}
          </Text>
          <Text style={sharedStyles.brandFooter}>{BRAND_FOOTER_TEXT}</Text>
        </Container>
      </Body>
    </Html>
  );
};

Email.PreviewProps = {
  lang: "en",
  documentType: "invoice",
  invoiceNumber: "2026-0042",
  firmName: "Example Law Office",
  amountDue: "EUR 1,250.00",
  dueDate: "14 November 2026",
  expiresOn: "26 December 2026",
  message: "Please find our invoice for October.",
  link: "http://localhost:3000/invoice-link#0000000000000000000000000000000000000000000000000000000000000000",
} satisfies InvoiceLinkEmailProps;

const styles: Record<string, React.CSSProperties> = {
  detail: {
    margin: "0 0 8px",
    color: brand.textPrimary,
    fontSize: "16px",
    lineHeight: "24px",
    textAlign: "center",
  },
  message: {
    margin: "16px 0",
    padding: "12px 16px",
    borderRadius: "8px",
    backgroundColor: brand.backgroundCodeBlock,
  },
  messageHeading: {
    margin: "0 0 4px",
    color: brand.textMuted,
    fontSize: "13px",
    lineHeight: "20px",
  },
  messageText: {
    margin: "0",
    color: brand.textPrimary,
    fontSize: "15px",
    lineHeight: "22px",
    whiteSpace: "pre-wrap",
  },
  buttonSection: {
    margin: "24px 0",
    textAlign: "center" as const,
  },
  button: {
    backgroundColor: brand.blue,
    borderRadius: "8px",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: "600",
    padding: "12px 24px",
    textDecoration: "none",
  },
};
