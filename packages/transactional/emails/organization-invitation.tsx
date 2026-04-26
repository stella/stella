import {
  Body,
  Button,
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

type Props = {
  inviteLink: string;
  organizationName: string;
  invitedByUsername: string;
  lang: SupportedLang;
};

export const subject = (
  lang: SupportedLang,
  { organizationName }: { organizationName: string },
) => getTranslator(lang)("invitation.subject", { organizationName });

export const Email = ({
  inviteLink,
  organizationName,
  invitedByUsername,
  lang,
}: Props) => {
  const t = getTranslator(lang);

  return (
    <Html lang={lang}>
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
          <Section style={styles["buttonSection"]}>
            <Button href={inviteLink} style={styles["button"]}>
              {t("invitation.accept")}
            </Button>
          </Section>
          <Text style={sharedStyles.muted}>{t("invitation.expires")}</Text>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>{t("invitation.ignore")}</Text>
          <Text style={sharedStyles.brandFooter}>stella — Legal workspace</Text>
        </Container>
      </Body>
    </Html>
  );
};

Email.PreviewProps = {
  inviteLink: "http://localhost:3000/auth/accept-invitation/xxx",
  organizationName: "Acme Inc",
  invitedByUsername: "Jane Doe",
  lang: "en",
} satisfies Props;

const styles: Record<string, React.CSSProperties> = {
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
