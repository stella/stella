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
