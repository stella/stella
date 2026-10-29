import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { AUTH_SOCIAL_PROVIDER_IDS } from "@stll/auth-model";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@stll/ui/input-otp";
import {
  List,
  ListGroup,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemTitle,
} from "@stll/ui/list";

import {
  socialProviderName,
  socialProviderSchema,
} from "@/components/auth/access-reset.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { linkedAccountsOptions } from "@/lib/account/queries";
import { useAnalytics } from "@/lib/analytics/provider";
import { authCapabilitiesOptions } from "@/lib/auth-capabilities";
import { authClient } from "@/lib/auth-client";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toAuthClientError } from "@/lib/errors/auth";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";

type SelectedAccount = { id: string; provider: string };
const CONFIRMATION_CODE_LENGTH = 6;

export const SignInMethods = () => {
  const t = useTranslations();
  const { id } = useAuthenticatedUser();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const accountsQuery = useQuery(linkedAccountsOptions(id));
  const capabilitiesQuery = useQuery(authCapabilitiesOptions);
  const accountsView = queryView(accountsQuery, { isEmpty: () => false });
  const capabilitiesView = queryView(capabilitiesQuery);
  const [selected, setSelected] = useState<SelectedAccount | null>(null);
  const [code, setCode] = useState("");
  const [confirmation, setConfirmation] = useState<"request" | "code">(
    "request",
  );
  const onError = (error: unknown) => {
    analytics.captureError(error, {
      fingerprintKey: "SignInMethods:mutation",
      scope: { type: "handler", handlerId: "SignInMethods:mutation" },
    });
    notifyUserError(error, t("errors.actionFailed"));
  };
  const connect = useMutation({
    mutationFn: async (provider: (typeof AUTH_SOCIAL_PROVIDER_IDS)[number]) => {
      const result = await authClient.linkSocial({
        provider,
        callbackURL: new URL(
          "/settings/account/profile",
          window.location.origin,
        ).toString(),
        errorCallbackURL: new URL(
          "/auth/error",
          window.location.origin,
        ).toString(),
      });
      readQueryResult(
        result.error
          ? Result.err(toAuthClientError(result.error))
          : Result.ok(undefined),
      );
    },
    onError,
  });
  const send = useMutation({
    mutationFn: async () => {
      const result = await authClient.$fetch("/sign-in-methods/send-otp", {
        method: "POST",
      });
      readQueryResult(
        result.error
          ? Result.err(toAuthClientError(result.error))
          : Result.ok(undefined),
      );
    },
    onSuccess: () => setConfirmation("code"),
    onError,
  });
  const unlink = useMutation({
    mutationFn: async (accountId: string) => {
      // The confirmation field is handled by the server's before hook.
      const result = await authClient.$fetch("/unlink-account", {
        method: "POST",
        body: { accountId, otp: code },
      });
      readQueryResult(
        result.error
          ? Result.err(toAuthClientError(result.error))
          : Result.ok(undefined),
      );
    },
    onSuccess: async (_result, accountId) => {
      setSelected(null);
      setCode("");
      setConfirmation("request");
      queryClient.setQueryData(linkedAccountsOptions(id).queryKey, (accounts) =>
        accounts?.filter((account) => account.id !== accountId),
      );
      const refreshed = await Result.tryPromise(
        async () =>
          await queryClient.invalidateQueries(linkedAccountsOptions(id)),
      );
      if (Result.isError(refreshed)) {
        analytics.captureError(refreshed.error, {
          fingerprintKey: "SignInMethods:refresh",
          scope: { type: "handler", handlerId: "SignInMethods:refresh" },
        });
        notifyUserError(refreshed.error, t("common.somethingWentWrong"));
      }
    },
    onError: (error) => {
      setCode("");
      setConfirmation("request");
      onError(error);
    },
  });
  const pending = connect.isPending || send.isPending || unlink.isPending;
  const dataReady =
    accountsView.type === "items" &&
    accountsView.refetchError === undefined &&
    capabilitiesView.type === "items" &&
    capabilitiesView.refetchError === undefined;

  return (
    <ListGroup>
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle>
            {t("settings.account.signInMethods.title")}
          </ListGroupTitle>
          <ListGroupDescription>
            {t("settings.account.signInMethods.description")}
          </ListGroupDescription>
        </ListGroupHeading>
      </ListGroupHeader>
      <QueryViewFeedback view={accountsView} />
      <QueryViewFeedback view={capabilitiesView} />
      {dataReady && (
        <List>
          {capabilitiesView.items.emailOtp && (
            <ListItem>
              <ListItemContent>
                <ListItemTitle>
                  {t("settings.account.signInMethods.emailCode")}
                </ListItemTitle>
                <ListItemDescription>
                  {t("settings.account.signInMethods.emailCodeDescription")}
                </ListItemDescription>
              </ListItemContent>
            </ListItem>
          )}
          {accountsView.items.map((account) => {
            const provider = v.safeParse(
              socialProviderSchema,
              account.providerId,
            );
            let name = account.providerId;
            if (provider.success) {
              name = socialProviderName(provider.output);
            } else if (account.providerId === "credential") {
              name = t("auth.password");
            }
            return (
              <ListItem key={account.id}>
                <ListItemContent>
                  <ListItemTitle>
                    <bdi>{name}</bdi>
                  </ListItemTitle>
                  {accountsView.items.length <= 1 && (
                    <ListItemDescription>
                      {t("settings.account.signInMethods.lastMethod")}
                    </ListItemDescription>
                  )}
                  {!capabilitiesView.items.transactionalEmail && (
                    <ListItemDescription>
                      {t("settings.account.signInMethods.unavailable")}
                    </ListItemDescription>
                  )}
                </ListItemContent>
                <ListItemActions>
                  <Button
                    variant="ghost"
                    disabled={
                      pending ||
                      accountsView.items.length <= 1 ||
                      !capabilitiesView.items.transactionalEmail
                    }
                    onClick={() => {
                      setSelected({ id: account.id, provider: name });
                      setCode("");
                      setConfirmation("request");
                    }}
                  >
                    {t("common.disconnect")}
                  </Button>
                </ListItemActions>
              </ListItem>
            );
          })}
          {AUTH_SOCIAL_PROVIDER_IDS.filter(
            (provider) =>
              capabilitiesView.items.social[provider] &&
              !accountsView.items.some(
                (account) => account.providerId === provider,
              ),
          ).map((provider) => (
            <ListItem key={provider}>
              <ListItemContent>
                <ListItemTitle>
                  <bdi>{socialProviderName(provider)}</bdi>
                </ListItemTitle>
              </ListItemContent>
              <ListItemActions>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => connect.mutate(provider)}
                >
                  {t("common.connect")}
                </Button>
              </ListItemActions>
            </ListItem>
          ))}
        </List>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setSelected(null);
            setCode("");
            setConfirmation("request");
          }
        }}
      >
        <DialogPopup>
          <DialogFormState dirty={code !== ""} />
          <DialogHeader>
            <DialogTitle>
              {t("settings.account.signInMethods.confirmTitle", {
                provider: selected?.provider ?? "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("settings.account.signInMethods.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          {confirmation === "code" && (
            <div className="px-6 pb-6">
              <InputOTP
                aria-label={t("settings.account.enterOtp")}
                autoFocus
                maxLength={CONFIRMATION_CODE_LENGTH}
                value={code}
                onChange={setCode}
                disabled={pending}
              >
                <InputOTPGroup>
                  {Array.from(
                    { length: CONFIRMATION_CODE_LENGTH },
                    (_, index) => (
                      <InputOTPSlot key={index} index={index} />
                    ),
                  )}
                </InputOTPGroup>
              </InputOTP>
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={pending} />}>
              {t("common.cancel")}
            </DialogClose>
            {confirmation === "request" ? (
              <Button disabled={pending} onClick={() => send.mutate()}>
                {t("settings.account.sendOtpCode")}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={
                  pending ||
                  code.length !== CONFIRMATION_CODE_LENGTH ||
                  !dataReady
                }
                onClick={() => {
                  if (selected) {
                    unlink.mutate(selected.id);
                  }
                }}
              >
                {t("common.disconnect")}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ListGroup>
  );
};
