import { render } from "@react-email/render";
import { panic } from "better-result";

import * as BetterAuthOTP from "@stll/transactional/emails/better-auth-otp";
import * as NewDeviceLogin from "@stll/transactional/emails/new-device-login";
import * as OrganizationInvitation from "@stll/transactional/emails/organization-invitation";

import { env } from "@/api/env";
import type { SupportedLang } from "@/api/lib/locale";

import { formatTransactionalEmailFrom } from "./from";
import { createSESTransport } from "./ses";
import { createSMTPTransport } from "./smtp";
import type { EmailTransport } from "./transport";

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
  formatTransactionalEmailFrom(env.TRANSACTIONAL_EMAIL_FROM);

type SendOTPEmailProps = {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
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
    subject: BetterAuthOTP.subject(lang),
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
    subject: NewDeviceLogin.subject(lang),
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
    subject: OrganizationInvitation.subject(lang, {
      organizationName,
    }),
    html,
    text,
  });
};
