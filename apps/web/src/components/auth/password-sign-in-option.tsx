import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { PasswordSignInForm } from "./password-sign-in-form";

/**
 * Password sign-in for the one account a deployment lets use a password,
 * standing in for the email step, with the way back to it.
 */
export const PasswordSignInOption = ({
  email,
  onUseEmailCode,
  redirectTo,
}: {
  /** The address already typed in the email step. */
  email: string;
  /** Absent when the page has no email step to return to. */
  onUseEmailCode: (() => void) | undefined;
  redirectTo: string;
}) => {
  const t = useTranslations();

  return (
    <>
      <PasswordSignInForm
        autoFocus
        defaultEmail={email}
        lastUsed={null}
        redirectTo={redirectTo}
      />
      {onUseEmailCode && (
        <Button
          className="self-center"
          onClick={onUseEmailCode}
          size="sm"
          type="button"
          variant="link"
        >
          {t("auth.useEmailCode")}
        </Button>
      )}
    </>
  );
};
