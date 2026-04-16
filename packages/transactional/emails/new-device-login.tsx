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

import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";

type Props = {
  device: string;
  ipAddress: string;
  time: string;
  sessionsUrl: string;
  lang: SupportedLang;
};

export const subject = (lang: SupportedLang) =>
  getTranslator(lang)("newDeviceLogin.subject");

export const Email = ({
  device,
  ipAddress,
  time,
  sessionsUrl,
  lang,
}: Props) => {
  const t = getTranslator(lang);

  return (
    <Html lang={lang}>
      <Head />
      <Preview>{t("newDeviceLogin.preview", { device })}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Heading style={styles.heading}>
            {t("newDeviceLogin.heading")}
          </Heading>
          <Text style={styles.text}>{t("newDeviceLogin.body")}</Text>
          <Section style={styles.detailsSection}>
            <Text style={styles.detailRow}>
              <strong>{t("newDeviceLogin.device")}:</strong> {device}
            </Text>
            <Text style={styles.detailRow}>
              <strong>{t("newDeviceLogin.ipAddress")}:</strong> {ipAddress}
            </Text>
            <Text style={styles.detailRow}>
              <strong>{t("newDeviceLogin.time")}:</strong> {time}
            </Text>
          </Section>
          <Section style={styles.buttonSection}>
            <Button href={sessionsUrl} style={styles.button}>
              {t("newDeviceLogin.action")}
            </Button>
          </Section>
          <Hr style={styles.hr} />
          <Text style={styles.footer}>{t("newDeviceLogin.ignore")}</Text>
        </Container>
      </Body>
    </Html>
  );
};

Email.PreviewProps = {
  device: "Chrome on macOS",
  ipAddress: "203.0.113.42",
  time: "Mar 6, 2026, 2:30 PM UTC",
  sessionsUrl: "http://localhost:3000/account/sessions",
  lang: "en",
} satisfies Props;

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: "0",
    backgroundColor: "#f6f9fc",
    padding: "24px 0",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  container: {
    margin: "0 auto",
    maxWidth: "520px",
    borderRadius: "12px",
    backgroundColor: "#ffffff",
    padding: "24px",
    border: "1px solid #e5e7eb",
  },
  heading: {
    margin: "0 0 12px",
    color: "#111827",
    fontSize: "24px",
    lineHeight: "32px",
    fontWeight: "700",
    textAlign: "center",
  },
  text: {
    margin: "0 0 16px",
    color: "#374151",
    fontSize: "16px",
    lineHeight: "24px",
    textAlign: "center",
  },
  detailsSection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: "#f3f4f6",
    padding: "16px",
  },
  detailRow: {
    margin: "0 0 4px",
    color: "#374151",
    fontSize: "14px",
    lineHeight: "22px",
  },
  buttonSection: {
    margin: "24px 0",
    textAlign: "center" as const,
  },
  button: {
    backgroundColor: "#111827",
    borderRadius: "8px",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: "600",
    padding: "12px 24px",
    textDecoration: "none",
  },
  hr: {
    margin: "0 0 16px",
    borderColor: "#e5e7eb",
  },
  footer: {
    margin: "0",
    color: "#6b7280",
    fontSize: "13px",
    lineHeight: "20px",
    textAlign: "center",
  },
};
