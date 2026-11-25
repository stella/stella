import { useTranslations } from "use-intl";

import { TruncatedText } from "@stll/ui/truncated-text";

/**
 * An AI subscription row's status when it is signed in: "Signed in as
 * {email}" on one line, cut with an ellipsis when the email is long and shown
 * whole on hover, focus or tap; "Signed in" when the account has no email.
 */
export const SignedInLine = ({ email }: { email: string | null }) => {
  const t = useTranslations("agentSubscriptions");
  if (email === null || email === "") {
    return t("signedIn");
  }
  return (
    <TruncatedText tooltip={email}>{t("signedInAs", { email })}</TruncatedText>
  );
};
