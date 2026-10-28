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
import { brand } from "./_shared";

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
      <Body style={styles["body"]}>
        <Container style={styles["container"]}>
          <Heading style={styles["heading"]}>
            {t("newDeviceLogin.heading")}
          </Heading>
          <Text style={styles["text"]}>{t("newDeviceLogin.body")}</Text>
          <Section style={styles["detailsSection"]}>
            <Text style={styles["detailRow"]}>
              <strong>{t("newDeviceLogin.device")}:</strong> {device}
            </Text>
            <Text style={styles["detailRow"]}>
              <strong>{t("newDeviceLogin.ipAddress")}:</strong> {ipAddress}
            </Text>
            <Text style={styles["detailRow"]}>
              <strong>{t("newDeviceLogin.time")}:</strong> {time}
            </Text>
          </Section>
          <Section style={styles["buttonSection"]}>
            <Button href={sessionsUrl} style={styles["button"]}>
              {t("newDeviceLogin.action")}
            </Button>
          </Section>
          <Hr style={styles["hr"]} />
          <Text style={styles["footer"]}>{t("newDeviceLogin.ignore")}</Text>
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
    backgroundColor: brand.backgroundPage,
    padding: "24px 0",
    fontFamily: brand.fontFamily,
  },
  container: {
    margin: "0 auto",
    maxWidth: "520px",
    borderRadius: "12px",
    backgroundColor: brand.backgroundCard,
    padding: "24px",
    border: `1px solid ${brand.border}`,
  },
  heading: {
    margin: "0 0 12px",
    color: brand.foreground,
    fontSize: "24px",
    lineHeight: "32px",
    fontWeight: "700",
    textAlign: "center",
  },
  text: {
    margin: "0 0 16px",
    color: brand.textPrimary,
    fontSize: "16px",
    lineHeight: "24px",
    textAlign: "center",
  },
  detailsSection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: brand.backgroundCodeBlock,
    padding: "16px",
  },
  detailRow: {
    margin: "0 0 4px",
    color: brand.textPrimary,
    fontSize: "14px",
    lineHeight: "22px",
  },
  buttonSection: {
    margin: "24px 0",
    textAlign: "center" as const,
  },
  button: {
    backgroundColor: brand.foreground,
    borderRadius: "8px",
    color: brand.foregroundOnAccent,
    fontSize: "16px",
    fontWeight: "600",
    padding: "12px 24px",
    textDecoration: "none",
  },
  hr: {
    margin: "0 0 16px",
    borderColor: brand.border,
  },
  footer: {
    margin: "0",
    color: brand.textMuted,
    fontSize: "13px",
    lineHeight: "20px",
    textAlign: "center",
  },
};
