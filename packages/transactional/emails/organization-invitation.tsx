import { Body } from "../components/body";
import { Button } from "../components/button";
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

type Props = {
  inviteLink: string;
  organizationName: string;
  invitedByUsername: string;
  lang: SupportedLang;
};

export const Email = ({
  inviteLink,
  organizationName,
  invitedByUsername,
  lang,
}: Props) => {
  const t = getTranslator(lang);

  return (
    <Html lang={lang} dir={getEmailDirection(lang)}>
      <Head />
      <Preview>
        {t("invitation.body", { organizationName, invitedByUsername })}
      </Preview>
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
          <Heading style={sharedStyles.heading}>
            {t("invitation.heading")}
          </Heading>
          <Text style={sharedStyles.text}>
            {t("invitation.body", {
              organizationName,
              invitedByUsername,
            })}
          </Text>
          <Section style={styles.buttonSection}>
            <Button href={inviteLink} style={styles.button}>
              {t("invitation.accept")}
            </Button>
          </Section>
          <Text style={sharedStyles.muted}>{t("invitation.expires")}</Text>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>{t("invitation.ignore")}</Text>
          <Text style={sharedStyles.brandFooter}>{BRAND_FOOTER_TEXT}</Text>
        </Container>
      </Body>
    </Html>
  );
};

const styles = {
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
} satisfies Record<string, React.CSSProperties>;
