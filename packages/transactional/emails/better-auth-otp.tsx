import {
  Body,
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

const otpTypeKey = {
  "sign-in": "otp.signIn",
  "email-verification": "otp.emailVerification",
  "forget-password": "otp.forgetPassword",
} as const;

type Props = {
  otp: string;
  type: keyof typeof otpTypeKey;
  lang: SupportedLang;
};

export const subject = (lang: SupportedLang) =>
  getTranslator(lang)("otp.subject");

export const Email = ({ otp, type, lang }: Props) => {
  const tr = getTranslator(lang);

  return (
    <Html lang={lang}>
      <Head />
      <Preview>{tr("otp.preview", { otp })}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Heading style={styles.heading}>{tr("otp.heading")}</Heading>
          <Text style={styles.text}>{tr(otpTypeKey[type])}</Text>
          <Section style={styles.codeSection}>
            <Text style={styles.code}>{otp}</Text>
          </Section>
          <Text style={styles.muted}>{tr("otp.expires")}</Text>
          <Hr style={styles.hr} />
          <Text style={styles.footer}>{tr("otp.ignore")}</Text>
        </Container>
      </Body>
    </Html>
  );
};

Email.PreviewProps = {
  otp: "123456",
  type: "sign-in",
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
  codeSection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: "#f3f4f6",
    padding: "16px",
    textAlign: "center" as const,
  },
  code: {
    margin: "0",
    color: "#111827",
    fontSize: "32px",
    lineHeight: "36px",
    letterSpacing: "6px",
    fontWeight: "700",
  },
  muted: {
    margin: "0 0 16px",
    color: "#6b7280",
    fontSize: "14px",
    lineHeight: "20px",
    textAlign: "center",
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
