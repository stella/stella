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
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Heading style={styles.heading}>{t("invitation.heading")}</Heading>
          <Text style={styles.text}>
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
          <Text style={styles.muted}>{t("invitation.expires")}</Text>
          <Hr style={styles.hr} />
          <Text style={styles.footer}>{t("invitation.ignore")}</Text>
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
