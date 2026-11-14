import { Body } from "../components/body";
import { Container } from "../components/container";
import { Head } from "../components/head";
import { Heading } from "../components/heading";
import { Hr } from "../components/hr";
import { Html } from "../components/html";
import { Img } from "../components/img";
import { Preview } from "../components/preview";
import { Section } from "../components/section";
import { Text } from "../components/text";
import { getEmailDirection, getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import { brand, BRAND_FOOTER_TEXT, ICON_URL, sharedStyles } from "./_shared";

const otpTypeKey = {
  "sign-in": "otp.signIn",
  "email-verification": "otp.emailVerification",

  "forget-password": "otp.forgetPassword",
  "change-email": "otp.changeEmail",
  "delete-account": "otp.deleteAccount",
  "two-factor-manage": "otp.twoFactorManage",
} as const;

type Props = {
  otp: string;
  type: keyof typeof otpTypeKey;
  lang: SupportedLang;
};

export const Email = ({ otp, type, lang }: Props) => {
  const tr = getTranslator(lang);

  return (
    <Html lang={lang} dir={getEmailDirection(lang)}>
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
          <Section style={styles.codeSection}>
            <Text style={styles.code}>{otp}</Text>
          </Section>
          <Text style={sharedStyles.muted}>{tr("otp.expires")}</Text>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>{tr("otp.ignore")}</Text>
          <Text style={sharedStyles.brandFooter}>{BRAND_FOOTER_TEXT}</Text>
        </Container>
      </Body>
    </Html>
  );
};

const styles = {
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
} satisfies Record<string, React.CSSProperties>;
