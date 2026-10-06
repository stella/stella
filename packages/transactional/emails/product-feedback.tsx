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

import type { FeedbackReportInput } from "@stll/api-contract/feedback";

import { BRAND_FOOTER_TEXT, brand, sharedStyles } from "./_shared";
import { KIND_LABELS } from "./product-feedback-subject";

/**
 * Maintainer-facing feedback email for one filed report.
 *
 * Unlike the other transactional emails this one is not user-facing and is not
 * localized: it goes to the project maintainer(s), so it is English-only and
 * skips the i18n translator. Every field is already sanitized upstream; the
 * reporter block is clearly separated and marked private, because it is the
 * one part of the report that is never published to the issue tracker.
 */

export const Email = ({ receipt, report, reporter, serverVersion }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`${KIND_LABELS[report.kind]}: ${report.title}`}</Preview>
    <Body style={sharedStyles.body}>
      <Container style={sharedStyles.container}>
        <Heading style={sharedStyles.heading}>
          {KIND_LABELS[report.kind]}
        </Heading>
        <Text style={styles["title"]}>{report.title}</Text>
        <Section style={styles["metaSection"]}>
          <DetailRow label="Receipt" value={receipt} />
          <DetailRow label="Area" value={report.area} />
          <DetailRow label="Server version" value={serverVersion} />
        </Section>
        <ReportBlock heading="What happened" body={report.whatHappened} />
        <ReportBlock heading="Expected" body={report.expected} />
        <ReportBlock heading="Steps" body={report.steps} />
        <ReportBlock heading="Evidence" body={report.evidence} />
        <ReportContext context={report.context} />
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

/**
 * Who filed the report. A mutually exclusive union, never a bag of optional
 * fields: an authenticated report carries the tenant identity the server
 * validated, while `intake` (the public receiver) has no user identity at all
 * and carries only the self-reported deployment.
 */
export type FeedbackReporter =
  | {
      via: "mcp" | "web";
      userId: string;
      organizationId: string;
      reporterEmail?: string;
    }
  | { via: "intake"; instance?: string };

type Props = {
  receipt: string;
  report: FeedbackReportInput;
  reporter: FeedbackReporter;
  serverVersion: string;
};

const ReportBlock = ({
  body,
  heading,
}: {
  body: string | undefined;
  heading: string;
}) => {
  if (body === undefined || body.length === 0) {
    return null;
  }
  return (
    <>
      <Text style={styles["sectionHeading"]}>{heading}</Text>
      <Section style={styles["bodySection"]}>
        <Text style={styles["bodyText"]}>{body}</Text>
      </Section>
    </>
  );
};

const ReportContext = ({
  context,
}: {
  context: FeedbackReportInput["context"];
}) => {
  if (context === undefined) {
    return null;
  }
  return (
    <>
      <Text style={styles["sectionHeading"]}>Context</Text>
      <Section style={styles["metaSection"]}>
        <DetailRow label="Client" value={context.client} />
        <DetailRow label="Client version" value={context.clientVersion} />
        <DetailRow label="Request id" value={context.requestId} />
        <DetailRow label="Route" value={context.route} />
        <DetailRow label="Error reference" value={context.errorReference} />
      </Section>
    </>
  );
};

const ReporterDetails = ({ reporter }: { reporter: FeedbackReporter }) => {
  if (reporter.via === "intake") {
    return (
      <>
        <Text style={styles["detailRow"]}>
          <strong>Channel:</strong> public intake (no user identity)
        </Text>
        <DetailRow label="Instance" value={reporter.instance} />
      </>
    );
  }
  return (
    <>
      <DetailRow label="Channel" value={reporter.via} />
      <DetailRow label="User ID" value={reporter.userId} />
      <DetailRow label="Organization ID" value={reporter.organizationId} />
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
  receipt: "FB-7K2M-9QXZ",
  serverVersion: "1.2.3",
  report: {
    kind: "bug",
    area: "documents",
    title: "read_document returns an empty body for large PDFs",
    whatHappened:
      "Calling read_document on a 200-page PDF answered with an empty string.",
    expected: "The first window of the extracted text, with a cursor.",
    steps: "1. Call read_document on a 200-page PDF.\n2. Read the response.",
    context: { client: "mcp", requestId: "req_01HZX8" },
  },
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
  sectionHeading: {
    margin: "0 0 8px",
    color: brand.textMuted,
    fontSize: "13px",
    lineHeight: "18px",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.4px",
  },
  bodySection: {
    marginBottom: "16px",
    borderRadius: "10px",
    backgroundColor: brand.backgroundCodeBlock,
    padding: "16px",
  },
  metaSection: {
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
