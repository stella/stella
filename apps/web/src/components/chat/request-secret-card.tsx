import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type {
  RequestSecretInput,
  RequestSecretOutput,
} from "@stll/api-contract/chat-secret";
import { Button } from "@stll/ui/button";
import { CheckIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { cn } from "@stll/ui/utils";

import { useChatApproval } from "@/components/chat/chat-approval-context";
import type {
  NormalConnectionAction,
  RequestSecretDecision,
  SecretTargetResolution,
} from "@/components/chat/chat-approval-context";
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

const getTargetConnection = (secretTarget: SecretTargetResolution) => ({
  connectionId: secretTarget.connector.connectionId,
  host: secretTarget.connector.host,
});

type RequestSecretCredentialFieldsProps = {
  value: string;
  saveForFuture: boolean;
  normalConnectionAction: NormalConnectionAction;
  responseDisposition: "normal" | "receipt-only";
  disabled: boolean;
  onValueChange: (value: string) => void;
  onSaveForFutureChange: (checked: boolean) => void;
  onNormalConnectionActionChange: (action: NormalConnectionAction) => void;
};

const RequestSecretCredentialFields = ({
  value,
  saveForFuture,
  normalConnectionAction,
  responseDisposition,
  disabled,
  onValueChange,
  onSaveForFutureChange,
  onNormalConnectionActionChange,
}: RequestSecretCredentialFieldsProps) => {
  const t = useTranslations();
  return (
    <>
      <label className="block space-y-1 text-sm">
        <span>{t("chat.requestSecret.valueLabel")}</span>
        <input
          autoComplete="off"
          className={cn(
            "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-2 md:text-sm",
          )}
          disabled={disabled}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          type="password"
          value={value}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          checked={saveForFuture}
          disabled={disabled}
          onChange={(event) =>
            onSaveForFutureChange(event.currentTarget.checked)
          }
          type="checkbox"
        />
        <span>{t("chat.requestSecret.saveForFuture")}</span>
      </label>
      {saveForFuture && responseDisposition === "normal" ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            checked={normalConnectionAction === "replace-with-receipt-only"}
            disabled={disabled}
            onChange={(event) =>
              onNormalConnectionActionChange(
                event.currentTarget.checked
                  ? "replace-with-receipt-only"
                  : "preserve",
              )
            }
            type="checkbox"
          />
          <span>{t("chat.requestSecret.replaceOrdinaryConnection")}</span>
        </label>
      ) : null}
    </>
  );
};

type RequestSecretDetailsProps = {
  input: RequestSecretInput;
  secretTarget: SecretTargetResolution | undefined;
  isCheckingTarget: boolean;
};

const RequestSecretDetails = ({
  input,
  secretTarget,
  isCheckingTarget,
}: RequestSecretDetailsProps) => {
  const t = useTranslations();
  return (
    <div className="mt-3 space-y-2 text-sm">
      <p className="text-muted-foreground">
        {t("chat.requestSecret.description")}
      </p>
      <p>{t("chat.requestSecret.purposeByAi", { purpose: input.purpose })}</p>
      <p className="text-muted-foreground">
        {t(REQUEST_SECRET_KIND_KEYS[input.kind])}
      </p>
      {secretTarget ? (
        <p className="text-muted-foreground">
          {t("chat.requestSecret.target", {
            target: `${secretTarget.connector.displayName} (${secretTarget.connector.host})`,
          })}
        </p>
      ) : null}
      {secretTarget ? (
        <p className="text-muted-foreground">
          {t("chat.requestSecret.connectionDisposition", {
            disposition: t(
              secretTarget.connector.responseDisposition === "normal"
                ? "chat.requestSecret.normalConnection"
                : "chat.requestSecret.receiptOnlyConnection",
            ),
          })}
        </p>
      ) : null}
      {input.formatHint ? (
        <p className="text-muted-foreground">{input.formatHint}</p>
      ) : null}
      <p className="text-muted-foreground font-medium">
        {t("chat.requestSecret.private")}
      </p>
      {isCheckingTarget ? (
        <p className="text-muted-foreground" role="status">
          {t("chat.requestSecret.checkingTarget")}
        </p>
      ) : null}
    </div>
  );
};

type RequestSecretContinuationRetryProps = {
  hasError: boolean;
  isSubmitting: boolean;
  onRetry: () => void;
};

const RequestSecretContinuationRetry = ({
  hasError,
  isSubmitting,
  onRetry,
}: RequestSecretContinuationRetryProps) => {
  const t = useTranslations();
  if (!hasError) {
    return null;
  }
  return (
    <div className="mt-4 space-y-3">
      <p className="text-destructive text-sm" role="alert">
        {t("chat.requestSecret.continuationError")}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={isSubmitting} onClick={onRetry} type="button">
          {isSubmitting ? <Loader className="size-4" /> : null}
          {t("chat.requestSecret.retryContinuationAction")}
        </Button>
      </div>
    </div>
  );
};

export const RequestSecretCard = ({
  isAwaitingUser,
  part,
}: RequestSecretCardProps) => {
  const t = useTranslations();
  const {
    handleRequestSecret,
    continueRequestSecret,
    secretAvailabilityKey,
    resolveSecretTarget,
  } = useChatApproval();
  const [value, setValue] = useState("");
  const [saveForFuture, setSaveForFuture] = useState(false);
  const [normalConnectionAction, setNormalConnectionAction] =
    useState<NormalConnectionAction>("preserve");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasError, setHasError] = useState(false);
  // The server-committed receipt (status, secretRef, target; never the
  // value). Held so a failed chat continuation retries only the
  // continuation instead of re-submitting the credential.
  const [heldReceipt, setHeldReceipt] = useState<RequestSecretOutput>();
  const [hasContinuationError, setHasContinuationError] = useState(false);
  const input = part.state === "input-streaming" ? null : part.input;
  const output = part.state === "complete" ? part.output : undefined;
  const shownOutput = output ?? heldReceipt;
  const isPending = isAwaitingUser && output === undefined;
  const connectorSlug = input?.target.connectorSlug;
  const savedSecretQuery = useQuery({
    queryKey: ["chat-saved-secret", secretAvailabilityKey, connectorSlug],
    enabled: isPending && connectorSlug !== undefined,
    queryFn: ({ signal }) => {
      if (connectorSlug === undefined) {
        return panic("Saved credential query requires a connector");
      }
      return resolveSecretTarget(connectorSlug, signal);
    },
  });
  const secretTarget = savedSecretQuery.isSuccess
    ? savedSecretQuery.data
    : undefined;

  const continueWithReceipt = async (receipt: RequestSecretOutput) => {
    setIsSubmitting(true);
    const result = await Result.tryPromise(() =>
      continueRequestSecret(part.id, receipt),
    );
    setHasContinuationError(Result.isError(result));
    setIsSubmitting(false);
  };

  const retryContinuation = async () => {
    if (heldReceipt === undefined || !isPending || isSubmitting) {
      return;
    }
    await continueWithReceipt(heldReceipt);
  };

  const submit = async (decision: RequestSecretDecision["decision"]) => {
    if (
      input === null ||
      input === undefined ||
      !isPending ||
      isSubmitting ||
      heldReceipt !== undefined
    ) {
      return;
    }
    if (
      (decision === "provide" || decision === "use-saved") &&
      (secretTarget === undefined ||
        (decision === "use-saved" && !secretTarget.available))
    ) {
      return;
    }
    if (
      decision === "provide" &&
      saveForFuture &&
      secretTarget !== undefined &&
      secretTarget.connector.responseDisposition === "normal" &&
      normalConnectionAction !== "replace-with-receipt-only"
    ) {
      return;
    }
    const submittedValue = value;
    setValue("");
    setIsSubmitting(true);
    setHasError(false);
    let submission: RequestSecretDecision;
    switch (decision) {
      case "provide": {
        if (secretTarget === undefined) {
          return;
        }
        submission = {
          decision,
          value: submittedValue,
          saveForFuture,
          normalConnectionAction: saveForFuture
            ? normalConnectionAction
            : "preserve",
          targetConnection: getTargetConnection(secretTarget),
        };
        break;
      }
      case "use-saved": {
        if (secretTarget === undefined || !secretTarget.available) {
          return;
        }
        submission = {
          decision,
          targetConnection: getTargetConnection(secretTarget),
        };
        break;
      }
      case "decline":
        submission = { decision };
        break;
      default: {
        decision satisfies never;
        return panic("Unhandled private input decision");
      }
    }
    const result = await Result.tryPromise(() =>
      handleRequestSecret(part.id, submission),
    );
    if (Result.isError(result)) {
      setHasError(true);
      setIsSubmitting(false);
      return;
    }
    setHeldReceipt(result.value);
    await continueWithReceipt(result.value);
  };

  return (
    <section
      aria-label={t("chat.requestSecret.title")}
      className="bg-muted/40 my-3 max-w-xl rounded-xl p-4"
      data-slot="request-secret-card"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {shownOutput?.status === "provided" ? (
          <CheckIcon aria-hidden="true" className="size-4" />
        ) : null}
        {t("chat.requestSecret.title")}
      </div>
      {input && shownOutput === undefined ? (
        <RequestSecretDetails
          input={input}
          isCheckingTarget={savedSecretQuery.isPending}
          secretTarget={secretTarget}
        />
      ) : null}
      {shownOutput ? (
        <p className="text-muted-foreground mt-3 text-sm">
          {shownOutput.status === "provided"
            ? t("chat.requestSecret.provided")
            : t("chat.requestSecret.declined")}
        </p>
      ) : null}
      {isPending && heldReceipt !== undefined ? (
        <RequestSecretContinuationRetry
          hasError={hasContinuationError}
          isSubmitting={isSubmitting}
          onRetry={() =>
            detached(
              retryContinuation(),
              "request-secret-card.retry-continuation",
            )
          }
        />
      ) : null}
      {isPending && input && heldReceipt === undefined ? (
        <div className="mt-4 space-y-3">
          {secretTarget ? (
            <RequestSecretCredentialFields
              disabled={isSubmitting}
              normalConnectionAction={normalConnectionAction}
              onNormalConnectionActionChange={setNormalConnectionAction}
              onSaveForFutureChange={(checked) => {
                setSaveForFuture(checked);
                if (!checked) {
                  setNormalConnectionAction("preserve");
                }
              }}
              onValueChange={setValue}
              responseDisposition={secretTarget.connector.responseDisposition}
              saveForFuture={saveForFuture}
              value={value}
            />
          ) : null}
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
            {secretTarget?.available === true ? (
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
            {secretTarget ? (
              <Button
                disabled={
                  isSubmitting ||
                  value.length === 0 ||
                  (saveForFuture &&
                    secretTarget.connector.responseDisposition === "normal" &&
                    normalConnectionAction !== "replace-with-receipt-only")
                }
                onClick={() =>
                  detached(submit("provide"), "request-secret-card.provide")
                }
                type="button"
              >
                {isSubmitting ? <Loader className="size-4" /> : null}
                {t("chat.requestSecret.provideAction")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
};
