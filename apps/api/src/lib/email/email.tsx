import { render } from "@react-email/render";
import { panic } from "better-result";

import * as BetterAuthOTP from "@stll/transactional/emails/better-auth-otp";
import { subject as betterAuthOTPSubject } from "@stll/transactional/emails/better-auth-otp-subject";
import * as NewDeviceLogin from "@stll/transactional/emails/new-device-login";
import { subject as newDeviceLoginSubject } from "@stll/transactional/emails/new-device-login-subject";
import * as OrganizationInvitation from "@stll/transactional/emails/organization-invitation";
import { subject as organizationInvitationSubject } from "@stll/transactional/emails/organization-invitation-subject";
import * as ProductFeedback from "@stll/transactional/emails/product-feedback";
import type { ProductFeedbackKind } from "@stll/transactional/emails/product-feedback";
import { subject as productFeedbackSubject } from "@stll/transactional/emails/product-feedback-subject";
import * as ReportExportStatus from "@stll/transactional/emails/report-export-status";
import type { ReportExportEmailStatus } from "@stll/transactional/emails/report-export-status";
import { subject as reportExportStatusSubject } from "@stll/transactional/emails/report-export-status-subject";

import { env } from "@/api/env";
import type { SupportedLang } from "@/api/lib/locale";

import { isEmailTransportConfigComplete } from "./config";
import { formatTransactionalEmailFrom } from "./from";
import { createSESTransport } from "./ses";
import { createSMTPTransport } from "./smtp";
import type { EmailTransport } from "./transport";

export const isTransactionalEmailConfigured = () =>
  isEmailTransportConfigComplete({
    emailProvider: env.EMAIL_PROVIDER,
    sesAccessKeyId: env.SES_ACCESS_KEY_ID,
    sesRegion: env.SES_REGION,
    sesSecretAccessKey: env.SES_SECRET_ACCESS_KEY,
    smtpHost: env.SMTP_HOST,
    smtpPassword: env.SMTP_PASSWORD,
    smtpPort: env.SMTP_PORT,
    smtpUsername: env.SMTP_USERNAME,
    transactionalEmailFrom: env.TRANSACTIONAL_EMAIL_FROM,
  });

const resolveTransport = (): EmailTransport => {
  switch (env.EMAIL_PROVIDER) {
    case "ses":
      return createSESTransport({
        region:
          env.SES_REGION ??
          panic("SES_REGION required when EMAIL_PROVIDER=ses"),
        ...(env.SES_ACCESS_KEY_ID && {
          accessKeyId: env.SES_ACCESS_KEY_ID,
        }),
        ...(env.SES_SECRET_ACCESS_KEY && {
          secretAccessKey: env.SES_SECRET_ACCESS_KEY,
        }),
        ...(env.SES_CONFIGURATION_SET && {
          configurationSetName: env.SES_CONFIGURATION_SET,
        }),
      });
    case "smtp":
      return createSMTPTransport({
        host:
          env.SMTP_HOST ?? panic("SMTP_HOST required when EMAIL_PROVIDER=smtp"),
        port:
          env.SMTP_PORT ?? panic("SMTP_PORT required when EMAIL_PROVIDER=smtp"),
        ...(env.SMTP_USERNAME && {
          username: env.SMTP_USERNAME,
        }),
        ...(env.SMTP_PASSWORD && {
          password: env.SMTP_PASSWORD,
        }),
        requireTLS: !env.isDev,
      });
    case undefined:
      return panic(
        "EMAIL_PROVIDER is required before sending transactional email",
      );
    default: {
      const _exhaustive: never = env.EMAIL_PROVIDER;
      return _exhaustive;
    }
  }
};

let cachedTransport: EmailTransport | undefined;

const getTransport = (): EmailTransport => {
  cachedTransport ??= resolveTransport();
  return cachedTransport;
};

const getTransactionalEmailFrom = () =>
  formatTransactionalEmailFrom(
    env.TRANSACTIONAL_EMAIL_FROM ??
      panic("TRANSACTIONAL_EMAIL_FROM is required before sending email"),
  );

type SendOTPEmailProps = {
  email: string;
  otp: string;
  type:
    | "sign-in"
    | "email-verification"
    | "forget-password"
    | "change-email"
    | "delete-account"
    | "two-factor-disable";
  lang: SupportedLang;
};

export const sendOTPEmail = async ({
  email,
  otp,
  type,
  lang,
}: SendOTPEmailProps) => {
  const node = <BetterAuthOTP.Email lang={lang} otp={otp} type={type} />;
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true }),
  ]);

  await getTransport().send({
    from: getTransactionalEmailFrom(),
    to: email,
    subject: betterAuthOTPSubject(lang),
    html,
    text,
  });
};

type SendNewDeviceLoginEmailProps = {
  email: string;
  device: string;
  ipAddress: string;
  time: string;
  sessionsUrl: string;
  lang: SupportedLang;
};

export const sendNewDeviceLoginEmail = async ({
  email,
  device,
  ipAddress,
  time,
  sessionsUrl,
  lang,
}: SendNewDeviceLoginEmailProps) => {
  const node = (
    <NewDeviceLogin.Email
      device={device}
      ipAddress={ipAddress}
      lang={lang}
      sessionsUrl={sessionsUrl}
      time={time}
    />
  );
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true }),
  ]);

  await getTransport().send({
    from: getTransactionalEmailFrom(),
    to: email,
    subject: newDeviceLoginSubject(lang),
    html,
    text,
  });
};

type SendOrganizationInvitationProps = {
  email: string;
  inviteLink: string;
  invitedByUsername: string;
  organizationName: string;
  lang: SupportedLang;
};

export const sendOrganizationInvitation = async ({
  email,
  inviteLink,
  invitedByUsername,
  organizationName,
  lang,
}: SendOrganizationInvitationProps) => {
  const node = (
    <OrganizationInvitation.Email
      invitedByUsername={invitedByUsername}
      inviteLink={inviteLink}
      lang={lang}
      organizationName={organizationName}
    />
  );
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true }),
  ]);

  await getTransport().send({
    from: getTransactionalEmailFrom(),
    to: email,
    subject: organizationInvitationSubject(lang, {
      organizationName,
    }),
    html,
    text,
  });
};

type SendFeedbackEmailOptions = {
  to: string;
  kind: ProductFeedbackKind;
  title: string;
  body: string;
  reporter: ProductFeedback.FeedbackReporter;
};

export const sendFeedbackEmail = async ({
  body,
  kind,
  reporter,
  title,
  to,
}: SendFeedbackEmailOptions) => {
  const node = (
    <ProductFeedback.Email
      body={body}
      kind={kind}
      reporter={reporter}
      title={title}
    />
  );
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true }),
  ]);

  await getTransport().send({
    from: getTransactionalEmailFrom(),
    to,
    subject: productFeedbackSubject({ kind, title }),
    html,
    text,
  });
};

type RenderReportExportStatusEmailOptions = {
  appUrl: string;
  lang: SupportedLang;
  status: ReportExportEmailStatus;
};

export const renderReportExportStatusEmail = async ({
  appUrl,
  lang,
  status,
}: RenderReportExportStatusEmailOptions) => {
  const node = (
    <ReportExportStatus.Email appUrl={appUrl} lang={lang} status={status} />
  );
  const [html, text] = await Promise.all([
    render(node),
    render(node, { plainText: true }),
  ]);
  return {
    html,
    subject: reportExportStatusSubject(lang, status),
    text,
  };
};

type SendReportExportStatusEmailOptions =
  RenderReportExportStatusEmailOptions & {
    email: string;
  };

export const sendReportExportStatusEmail = async ({
  appUrl,
  email,
  lang,
  status,
}: SendReportExportStatusEmailOptions) => {
  const rendered = await renderReportExportStatusEmail({
    appUrl,
    lang,
    status,
  });
  await getTransport().send({
    from: getTransactionalEmailFrom(),
    to: email,
    ...rendered,
  });
};
