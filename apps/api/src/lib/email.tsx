import { Resend } from "resend";

import * as BetterAuthOTP from "@stella/transactional/emails/better-auth-otp";
import * as OrganizationInvitation from "@stella/transactional/emails/organization-invitation";

import { env } from "@/api/env";
import type { SupportedLang } from "@/api/lib/locale";

const resend = new Resend(env.RESEND_API_KEY);

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
  await resend.emails.send({
    from: env.TRANSACTIONAL_EMAIL_FROM,
    to: email,
    subject: BetterAuthOTP.subject(lang),
    react: <BetterAuthOTP.Email lang={lang} otp={otp} type={type} />,
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
  await resend.emails.send({
    from: env.TRANSACTIONAL_EMAIL_FROM,
    to: email,
    subject: OrganizationInvitation.subject(lang, {
      organizationName,
    }),
    react: (
      <OrganizationInvitation.Email
        invitedByUsername={invitedByUsername}
        inviteLink={inviteLink}
        lang={lang}
        organizationName={organizationName}
      />
    ),
  });
};
