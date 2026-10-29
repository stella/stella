import { Body } from "../components/body";
import { Button } from "../components/button";
import { Container } from "../components/container";
import { Head } from "../components/head";
import { Heading } from "../components/heading";
import { Hr } from "../components/hr";
import { Html } from "../components/html";
import { Preview } from "../components/preview";
import { Section } from "../components/section";
import { Text } from "../components/text";
import { getEmailDirection, getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";

type Props = {
  device: string;
  ipAddress: string;
  time: string;
  sessionsUrl: string;
  lang: SupportedLang;
};

export const Email = ({
  device,
  ipAddress,
  time,
  sessionsUrl,
  lang,
}: Props) => {
  const t = getTranslator(lang);

  return (
    <Html lang={lang} dir={getEmailDirection(lang)}>
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

const styles = {
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
} satisfies Record<string, React.CSSProperties>;
