import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type {
  RequestSecretInput,
  RequestSecretOutput,
} from "@stll/api-contract/chat-secret";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { CheckIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import { useChatApproval } from "@/components/chat/chat-approval-context";
import type {
  NormalConnectionAction,
  RequestSecretDecision,
  SecretTargetResolution,
} from "@/components/chat/chat-approval-context";
import type { RegisteredChatUIToolCallPart } from "@/components/chat/chat-ui-tools";
import { SecretInput } from "@/components/secret-input";
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
  password: "auth.password",
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
      <Field className="items-stretch">
        <FieldLabel>{t("chat.requestSecret.valueLabel")}</FieldLabel>
        <SecretInput
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          value={value}
        />
      </Field>
      <Field className="min-h-11 flex-row items-center gap-2">
        <Checkbox
          checked={saveForFuture}
          disabled={disabled}
          onCheckedChange={(checked) => onSaveForFutureChange(checked)}
        />
        <FieldLabel>{t("chat.requestSecret.saveForFuture")}</FieldLabel>
      </Field>
      {saveForFuture && responseDisposition === "normal" ? (
        <Field className="min-h-11 flex-row items-center gap-2">
          <Checkbox
            checked={normalConnectionAction === "replace-with-receipt-only"}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onNormalConnectionActionChange(
                checked ? "replace-with-receipt-only" : "preserve",
              )
            }
          />
          <FieldLabel>
            {t("chat.requestSecret.replaceOrdinaryConnection")}
          </FieldLabel>
        </Field>
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

type ContinuationStatus = "running" | "failed" | "retrying" | "done";

/**
 * One credential request moves through these phases in order. Once the
 * server commits the receipt (status, secretRef, target; never the value),
 * the card holds it, so a failed chat continuation retries only the
 * continuation instead of re-submitting the credential. Retry availability
 * follows the continuation, not the part state: addToolResult writes the
 * output onto the part before resuming the chat.
 */
type SubmissionPhase =
  | { status: "editing"; submitFailed: boolean }
  | { status: "submitting" }
  | {
      status: "held";
      receipt: RequestSecretOutput;
      continuation: ContinuationStatus;
    };

type PhaseView = {
  continuation: ContinuationStatus | undefined;
  heldReceipt: RequestSecretOutput | undefined;
  isBusy: boolean;
  submitFailed: boolean;
};

const readPhase = (phase: SubmissionPhase): PhaseView => {
  switch (phase.status) {
    case "editing":
      return {
        continuation: undefined,
        heldReceipt: undefined,
        isBusy: false,
        submitFailed: phase.submitFailed,
      };
    case "submitting":
      return {
        continuation: undefined,
        heldReceipt: undefined,
        isBusy: true,
        submitFailed: false,
      };
    case "held":
      return {
        continuation: phase.continuation,
        heldReceipt: phase.receipt,
        isBusy:
          phase.continuation === "running" || phase.continuation === "retrying",
        submitFailed: false,
      };
    default: {
      phase satisfies never;
      return panic("Unhandled request secret phase");
    }
  }
};

type RequestSecretContinuationRetryProps = {
  continuation: ContinuationStatus;
  onRetry: () => void;
};

const RequestSecretContinuationRetry = ({
  continuation,
  onRetry,
}: RequestSecretContinuationRetryProps) => {
  const t = useTranslations();
  if (continuation !== "failed" && continuation !== "retrying") {
    return null;
  }
  const isRetrying = continuation === "retrying";
  return (
    <div className="mt-4 space-y-3">
      <p className="text-destructive text-sm" role="alert">
        {t("chat.requestSecret.continuationError")}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={isRetrying} onClick={onRetry} type="button">
          {isRetrying ? (
            <Loader className="size-4" variant="decorative" />
          ) : null}
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
  const [phase, setPhase] = useState<SubmissionPhase>({
    status: "editing",
    submitFailed: false,
  });
  const {
    continuation,
    heldReceipt,
    isBusy: isSubmitting,
    submitFailed,
  } = readPhase(phase);
  const input = part.state === "input-streaming" ? null : part.input;
  const output = part.state === "complete" ? part.output : undefined;
  const shownOutput = output ?? heldReceipt;
  const isPending = isAwaitingUser && output === undefined;
  const connectorSlug = input?.target.connectorSlug;
  const savedSecretQuery = useQuery({
    queryKey: ["chat-saved-secret", secretAvailabilityKey, connectorSlug],
    enabled: isPending && connectorSlug !== undefined,
    queryFn: async ({ signal }) => {
      if (connectorSlug === undefined) {
        return panic("Saved credential query requires a connector");
      }
      return await resolveSecretTarget(connectorSlug, signal);
    },
  });
  const secretTarget = savedSecretQuery.isSuccess
    ? savedSecretQuery.data
    : undefined;

  const continueWithReceipt = async (
    receipt: RequestSecretOutput,
    attempt: "running" | "retrying",
  ) => {
    setPhase({ status: "held", receipt, continuation: attempt });
    const result = await Result.tryPromise(
      async () => await continueRequestSecret(part.id, receipt),
    );
    setPhase({
      status: "held",
      receipt,
      continuation: Result.isError(result) ? "failed" : "done",
    });
  };

  const retryContinuation = async () => {
    if (phase.status !== "held" || phase.continuation !== "failed") {
      return;
    }
    await continueWithReceipt(phase.receipt, "retrying");
  };

  const submit = async (decision: RequestSecretDecision["decision"]) => {
    if (
      input === null ||
      input === undefined ||
      !isPending ||
      phase.status !== "editing"
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
      secretTarget?.connector.responseDisposition === "normal" &&
      normalConnectionAction !== "replace-with-receipt-only"
    ) {
      return;
    }
    let submission: RequestSecretDecision;
    switch (decision) {
      case "provide": {
        if (secretTarget === undefined) {
          return;
        }
        submission = {
          decision,
          value,
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
        panic("Unhandled private input decision");
      }
    }
    setValue("");
    setPhase({ status: "submitting" });
    const result = await Result.tryPromise(
      async () => await handleRequestSecret(part.id, submission),
    );
    if (Result.isError(result)) {
      setPhase({ status: "editing", submitFailed: true });
      return;
    }
    await continueWithReceipt(result.value, "running");
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
      {continuation !== undefined ? (
        <RequestSecretContinuationRetry
          continuation={continuation}
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
          {submitFailed ? (
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
                {isSubmitting ? (
                  <Loader className="size-4" variant="decorative" />
                ) : null}
                {t("chat.requestSecret.provideAction")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
};
