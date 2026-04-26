import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";

import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import { ICON_URL, brand, sharedStyles } from "./_shared";

const otpTypeKey = {
  "sign-in": "otp.signIn",
  "email-verification": "otp.emailVerification",
  "forget-password": "otp.forgetPassword",
  "change-email": "otp.changeEmail",
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
      <Preview>{tr("otp.preview")}</Preview>
      <Body style={sharedStyles.body}>
        <Container style={sharedStyles.container}>
          <Section style={sharedStyles.wordmarkSection}>
            <Img
              src={ICON_URL}
              alt="stella"
              width="40"
              height="40"
              style={{ margin: "0 auto", display: "block" }}
            />
          </Section>
          <Heading style={sharedStyles.heading}>{tr("otp.heading")}</Heading>
          <Text style={sharedStyles.text}>{tr(otpTypeKey[type])}</Text>
          <Section style={styles["codeSection"]}>
            <Text style={styles["code"]}>{otp}</Text>
          </Section>
          <Text style={sharedStyles.muted}>{tr("otp.expires")}</Text>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>{tr("otp.ignore")}</Text>
          <Text style={sharedStyles.brandFooter}>stella — Legal workspace</Text>
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
  codeSection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: brand.backgroundCodeBlock,
    padding: "16px",
    textAlign: "center" as const,
  },
  code: {
    margin: "0",
    color: brand.foreground,
    fontSize: "32px",
    lineHeight: "36px",
    letterSpacing: "6px",
    fontWeight: "700",
  },
};
