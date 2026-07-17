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

import { getEmailDirection, getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";
import { BRAND_FOOTER_TEXT, ICON_URL, brand, sharedStyles } from "./_shared";

export type ReportExportEmailStatus = "completed" | "failed";

type Props = {
  appUrl: string;
  lang: SupportedLang;
  status: ReportExportEmailStatus;
};

export const Email = ({ appUrl, lang, status }: Props) => {
  const t = getTranslator(lang);
  const keys = STATUS_KEYS[status];

  return (
    <Html lang={lang} dir={getEmailDirection(lang)}>
      <Head />
      <Preview>{t(keys.preview)}</Preview>
      <Body style={sharedStyles.body}>
        <Container style={sharedStyles.container}>
          <Section style={sharedStyles.wordmarkSection}>
            <Img
              alt="stella"
              height="40"
              src={ICON_URL}
              style={{ margin: "0 auto", display: "block" }}
              width="40"
            />
          </Section>
          <Heading style={sharedStyles.heading}>{t(keys.heading)}</Heading>
          <Text style={sharedStyles.text}>{t(keys.body)}</Text>
          <Section style={styles.buttonSection}>
            <Button href={appUrl} style={styles.button}>
              {t("reportExportStatus.action")}
            </Button>
          </Section>
          <Hr style={sharedStyles.hr} />
          <Text style={sharedStyles.footer}>
            {t("reportExportStatus.privacy")}
          </Text>
          <Text style={sharedStyles.brandFooter}>{BRAND_FOOTER_TEXT}</Text>
        </Container>
      </Body>
    </Html>
  );
};

Email.PreviewProps = {
  appUrl: "http://localhost:3000/workspaces",
  lang: "en",
  status: "completed",
} satisfies Props;

const STATUS_KEYS = {
  completed: {
    body: "reportExportStatus.completedBody",
    heading: "reportExportStatus.completedHeading",
    preview: "reportExportStatus.completedPreview",
  },
  failed: {
    body: "reportExportStatus.failedBody",
    heading: "reportExportStatus.failedHeading",
    preview: "reportExportStatus.failedPreview",
  },
} as const;

const styles = {
  buttonSection: {
    margin: "24px 0",
    textAlign: "center",
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
