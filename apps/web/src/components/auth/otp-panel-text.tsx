import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

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
