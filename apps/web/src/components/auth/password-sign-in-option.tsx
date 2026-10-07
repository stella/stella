import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { PasswordSignInForm } from "./password-sign-in-form";

/**
 * Password sign-in kept out of the way: a quiet link that opens the form.
 * Offered when the deployment allows one configured account to use a
 * password rather than as a sign-in method for everyone.
 */
export const PasswordSignInOption = ({
  redirectTo,
}: {
  redirectTo: string;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <PasswordSignInForm autoFocus lastUsed={null} redirectTo={redirectTo} />
    );
  }
  return (
    <Button
      aria-expanded={false}
      className="self-center"
      onClick={() => setOpen(true)}
      size="sm"
      type="button"
      variant="link"
    >
      {t("auth.usePassword")}
    </Button>
  );
};
