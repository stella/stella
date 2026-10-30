import type { ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";

import { signOutAndRelease } from "@/hooks/use-sign-out";
import { useAnalytics } from "@/lib/analytics/provider";
import { sessionOptions } from "@/lib/auth-queries";
import { toAuthClientError } from "@/lib/errors/auth";
import { getOauthAccountSwitchHref } from "@/lib/oauth-provider";

/**
 * Signs the current account out and returns to sign-in with the same signed
 * OAuth request, so the account signed in next resumes that authorization.
 * Every OAuth step that shows the signed-in account switches through here.
 */
export const useOAuthAccountSwitch = () => {
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  return async (): Promise<Result<void, unknown>> => {
    const outcome = await Result.tryPromise(
      async () => await signOutAndRelease(),
    );
    // A failed request may still have ended the session; show what the
    // server now holds before the user retries.
    const fail = async (error: unknown) => {
      await queryClient.refetchQueries({ queryKey: sessionOptions.queryKey });
      return Result.err(error);
    };
    if (outcome.isErr()) {
      return await fail(outcome.error);
    }
    if (outcome.value.error) {
      return await fail(toAuthClientError(outcome.value.error));
    }
    analytics.reset();
    window.location.assign(
      getOauthAccountSwitchHref({
        hash: window.location.hash,
        pathname: window.location.pathname,
        search: window.location.search,
      }),
    );
    return Result.ok(undefined);
  };
};

/** The term list the OAuth steps use to say who is signed in. */
export const OAuthAccountList = ({ children }: { children: ReactNode }) => (
  <DetailsGrid variant="list">{children}</DetailsGrid>
);

type OAuthAccountRowProps = {
  disabled: boolean;
  email: string;
  onAccountSwitch: () => void;
};

/** The signed-in account, with the way out to a different one. */
export const OAuthAccountRow = ({
  disabled,
  email,
  onAccountSwitch,
}: OAuthAccountRowProps) => {
  const t = useTranslations("consent");
  const tAccount = useTranslations("settings.account");
  return (
    <DetailsItem
      className="items-start sm:items-center"
      label={tAccount("title")}
    >
      <div className="flex min-w-0 flex-col items-start gap-x-3 sm:flex-row sm:items-center sm:justify-between">
        <bdi className="min-w-0 break-all">{email}</bdi>
        <Button
          variant="link"
          size="xs"
          className="-ms-2 min-h-11 self-start sm:ms-0 sm:self-auto"
          disabled={disabled}
          onClick={onAccountSwitch}
        >
          {t("useAnotherAccount")}
        </Button>
      </div>
    </DetailsItem>
  );
};
