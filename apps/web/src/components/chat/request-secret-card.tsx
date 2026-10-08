import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { RequestSecretInput } from "@stll/api-contract/chat-secret";
import { Button } from "@stll/ui/button";
import { CheckIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { cn } from "@stll/ui/utils";

import { useChatApproval } from "@/components/chat/chat-approval-context";
import type { RegisteredChatUIToolCallPart } from "@/components/chat/chat-ui-tools";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";

type RequestSecretPart = Extract<
  RegisteredChatUIToolCallPart,
  { name: "request_secret" }
>;

type RequestSecretCardProps = {
  isAwaitingUser: boolean;
  part: RequestSecretPart;
};

const REQUEST_SECRET_KIND_KEYS = {
  token: "chat.requestSecret.kind.token",
  password: "common.password",
  key: "common.key",
} as const satisfies Record<RequestSecretInput["kind"], TranslationKey>;

export const RequestSecretCard = ({
  isAwaitingUser,
  part,
}: RequestSecretCardProps) => {
  const t = useTranslations();
  const {
    handleRequestSecret,
    secretAvailabilityKey,
    checkSavedSecretAvailability,
  } = useChatApproval();
  const [value, setValue] = useState("");
  const [saveForFuture, setSaveForFuture] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasError, setHasError] = useState(false);
  const input = part.state === "input-streaming" ? null : part.input;
  const output = part.state === "complete" ? part.output : undefined;
  const isPending = isAwaitingUser && output === undefined;
  const connectorSlug = input?.target.connectorSlug;
  const savedSecretQuery = useQuery({
    queryKey: ["chat-saved-secret", secretAvailabilityKey, connectorSlug],
    enabled: isPending && connectorSlug !== undefined,
    queryFn: ({ signal }) => {
      if (connectorSlug === undefined) {
        return panic("Saved credential query requires a connector");
      }
      return checkSavedSecretAvailability(connectorSlug, signal);
    },
  });

  const submit = async (decision: "provide" | "use-saved" | "decline") => {
    if (input === null || input === undefined || !isPending || isSubmitting) {
      return;
    }
    const submittedValue = value;
    setValue("");
    setIsSubmitting(true);
    setHasError(false);
    const result = await Result.tryPromise(() =>
      handleRequestSecret(
        part.id,
        decision === "provide"
          ? { decision, value: submittedValue, saveForFuture }
          : { decision },
      ),
    );
    if (Result.isError(result)) {
      setHasError(true);
    }
    setIsSubmitting(false);
  };

  return (
    <section
      aria-label={t("chat.requestSecret.title")}
      className="bg-muted/40 my-3 max-w-xl rounded-xl p-4"
      data-slot="request-secret-card"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {output?.status === "provided" ? (
          <CheckIcon aria-hidden="true" className="size-4" />
        ) : null}
        {t("chat.requestSecret.title")}
      </div>
      {input && output === undefined ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-muted-foreground">
            {t("chat.requestSecret.description")}
          </p>
          <p>{input.purpose}</p>
          <p className="text-muted-foreground">
            {t(REQUEST_SECRET_KIND_KEYS[input.kind])}
          </p>
          <p className="text-muted-foreground">
            {t("chat.requestSecret.target", {
              target: input.target.connectorSlug,
            })}
          </p>
          {input.formatHint ? (
            <p className="text-muted-foreground">{input.formatHint}</p>
          ) : null}
          <p className="text-muted-foreground font-medium">
            {t("chat.requestSecret.private")}
          </p>
        </div>
      ) : null}
      {output ? (
        <p className="text-muted-foreground mt-3 text-sm">
          {output.status === "provided"
            ? t("chat.requestSecret.provided")
            : t("chat.requestSecret.declined")}
        </p>
      ) : null}
      {isPending && input ? (
        <div className="mt-4 space-y-3">
          <label className="block space-y-1 text-sm">
            <span>{t("chat.requestSecret.valueLabel")}</span>
            <input
              autoComplete="off"
              className={cn(
                "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-2 md:text-sm",
              )}
              disabled={isSubmitting}
              onChange={(event) => setValue(event.currentTarget.value)}
              type="password"
              value={value}
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              checked={saveForFuture}
              disabled={isSubmitting}
              onChange={(event) =>
                setSaveForFuture(event.currentTarget.checked)
              }
              type="checkbox"
            />
            <span>{t("chat.requestSecret.saveForFuture")}</span>
          </label>
          {hasError ? (
            <p className="text-destructive text-sm" role="alert">
              {t("chat.requestSecret.error")}
            </p>
          ) : null}
          {savedSecretQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              {t("chat.requestSecret.savedAvailabilityError")}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={isSubmitting}
              onClick={() =>
                detached(submit("decline"), "request-secret-card.decline")
              }
              type="button"
              variant="ghost"
            >
              {t("common.decline")}
            </Button>
            {savedSecretQuery.data === true ? (
              <Button
                disabled={isSubmitting}
                onClick={() =>
                  detached(submit("use-saved"), "request-secret-card.use-saved")
                }
                type="button"
                variant="outline"
              >
                {t("chat.requestSecret.useSavedAction")}
              </Button>
            ) : null}
            <Button
              disabled={isSubmitting || value.length === 0}
              onClick={() =>
                detached(submit("provide"), "request-secret-card.provide")
              }
              type="button"
            >
              {isSubmitting ? <Loader className="size-4" /> : null}
              {t("chat.requestSecret.provideAction")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
};
