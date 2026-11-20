import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { EmailDeliveryFailureReason } from "@stll/api-contract/email-delivery";
import { BidiText } from "@stll/ui/bidi-text";

import { emailDomain } from "./email-delivery.logic";

export const renderEmail = (chunks: ReactNode) => (
  <BidiText direction="ltr">{chunks}</BidiText>
);

export const OTPEmailText = ({
  email,
  id,
}: {
  email: string;
  id: "auth.weSentCodeTo" | "auth.resendCode";
}) => {
  const t = useTranslations();
  return <>{t.rich(id, { email: renderEmail, emailAddress: email })}</>;
};

/** Why mail to the address recently failed, and what to do about it. */
export const EmailDeliveryFailureText = ({
  email,
  reason,
}: {
  email: string;
  reason: EmailDeliveryFailureReason;
}) => {
  const t = useTranslations();
  const values = { email: renderEmail, emailAddress: email };
  switch (reason) {
    case "tls_required":
      return (
        <>
          {t.rich("auth.emailDelivery.tlsRequired", {
            domain: renderEmail,
            domainName: emailDomain(email),
          })}
        </>
      );
    case "mailbox_missing":
      return <>{t.rich("auth.emailDelivery.mailboxMissing", values)}</>;
    case "mailbox_unavailable":
      return <>{t.rich("auth.emailDelivery.mailboxUnavailable", values)}</>;
    case "suppressed":
      return <>{t.rich("auth.emailDelivery.suppressed", values)}</>;
    case "other":
      return <>{t.rich("auth.emailDelivery.other", values)}</>;
    default:
      reason satisfies never;
      return panic(`Unhandled email delivery failure: ${String(reason)}`);
  }
};
