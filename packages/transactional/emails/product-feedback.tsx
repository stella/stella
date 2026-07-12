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

import { BRAND_FOOTER_TEXT, brand, sharedStyles } from "./_shared";
import { KIND_LABELS } from "./product-feedback-subject";

/**
 * Maintainer-facing feedback email filed through the MCP `send_feedback` tool.
 *
 * Unlike the other transactional emails this one is not user-facing and is not
 * localized: it goes to the project maintainer(s), so it is English-only and
 * skips the i18n translator. The title/body are already sanitized upstream; the
 * reporter block is clearly separated and marked private (it is never published
 * to the public issue tracker).
 */

export type ProductFeedbackKind = "bug" | "feature_request" | "docs" | "other";

/**
 * Who filed the feedback. A mutually exclusive union, never a bag of optional
 * fields: `mcp` carries the tenant identity of the signed-in agent user, while
 * `intake` (the public receiver) has no user identity at all and carries only
 * the self-reported deployment source.
 */
export type FeedbackReporter =
  | {
      via: "mcp";
      userId: string;
      organizationId: string;
      reporterEmail?: string;
    }
  | { via: "intake"; instance?: string; version?: string };

type Props = {
  kind: ProductFeedbackKind;
  title: string;
  body: string;
  reporter: FeedbackReporter;
};

export const Email = ({ body, kind, reporter, title }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`${KIND_LABELS[kind]}: ${title}`}</Preview>
    <Body style={sharedStyles.body}>
      <Container style={sharedStyles.container}>
        <Heading style={sharedStyles.heading}>{KIND_LABELS[kind]}</Heading>
        <Text style={styles["title"]}>{title}</Text>
        <Section style={styles["bodySection"]}>
          <Text style={styles["bodyText"]}>{body}</Text>
        </Section>
        <Hr style={sharedStyles.hr} />
        <Text style={styles["reporterHeading"]}>
          Reporter (private, not published)
        </Text>
        <Section style={styles["reporterSection"]}>
          <ReporterDetails reporter={reporter} />
        </Section>
        <Text style={sharedStyles.brandFooter}>{BRAND_FOOTER_TEXT}</Text>
      </Container>
    </Body>
  </Html>
);

const ReporterDetails = ({ reporter }: { reporter: FeedbackReporter }) => {
  if (reporter.via === "intake") {
    return (
      <>
        <Text style={styles["detailRow"]}>
          <strong>Channel:</strong> hosted intake (no user identity)
        </Text>
        <DetailRow label="Instance" value={reporter.instance} />
        <DetailRow label="Version" value={reporter.version} />
      </>
    );
  }
  return (
    <>
      <Text style={styles["detailRow"]}>
        <strong>User ID:</strong> {reporter.userId}
      </Text>
      <Text style={styles["detailRow"]}>
        <strong>Organization ID:</strong> {reporter.organizationId}
      </Text>
      <DetailRow label="Email" value={reporter.reporterEmail} />
    </>
  );
};

const DetailRow = ({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) => {
  if (value === undefined) {
    return null;
  }
  return (
    <Text style={styles["detailRow"]}>
      <strong>{label}:</strong> {value}
    </Text>
  );
};

Email.PreviewProps = {
  kind: "bug",
  title: "read_document returns an empty body for large PDFs",
  body: "Steps:\n1. Call read_document on a 200-page PDF.\n2. Response body is empty.\n\nExpected: windowed text. Actual: empty string.",
  reporter: {
    via: "mcp",
    userId: "user_1",
    organizationId: "org_1",
    reporterEmail: "reporter@example.com",
  },
} satisfies Props;

const styles: Record<string, React.CSSProperties> = {
  title: {
    margin: "0 0 16px",
    color: brand.foreground,
    fontSize: "18px",
    lineHeight: "26px",
    fontWeight: "600",
    textAlign: "left",
  },
  bodySection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: brand.backgroundCodeBlock,
    padding: "16px",
  },
  bodyText: {
    margin: "0",
    color: brand.textPrimary,
    fontSize: "14px",
    lineHeight: "22px",
    whiteSpace: "pre-wrap",
  },
  reporterHeading: {
    margin: "0 0 8px",
    color: brand.textMuted,
    fontSize: "13px",
    lineHeight: "18px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.4px",
  },
  reporterSection: {
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
};
