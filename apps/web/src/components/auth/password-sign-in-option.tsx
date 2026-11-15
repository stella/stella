import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { PasswordSignInForm } from "./password-sign-in-form";
import type { PasswordEntry } from "./sign-in-panel.logic";

/**
 * Password sign-in kept out of the way: a quiet link that opens the form.
 * Offered when the deployment allows one configured account to use a
 * password rather than as a sign-in method for everyone.
 */
export const PasswordSignInOption = ({
  entry,
  onOpen,
  redirectTo,
}: {
  entry: PasswordEntry;
  onOpen: () => void;
  redirectTo: string;
}) => {
  const t = useTranslations();

  switch (entry.type) {
    case "closed":
      return (
        <Button
          aria-expanded={false}
          className="self-center"
          onClick={onOpen}
          size="sm"
          type="button"
          variant="link"
        >
          {t("auth.usePassword")}
        </Button>
      );
    case "offered":
      return (
        <PasswordSignInForm
          key="offered"
          autoFocus
          defaultEmail=""
          lastUsed={null}
          redirectTo={redirectTo}
        />
      );
    case "required":
      return (
        // Keyed apart from the offered form: an address the server named
        // must replace whatever that form already held.
        <PasswordSignInForm
          key="required"
          autoFocus
          defaultEmail={entry.email}
          lastUsed={null}
          redirectTo={redirectTo}
        />
      );
    default:
      entry satisfies never;
      return panic("Unknown password entry state");
  }
};
