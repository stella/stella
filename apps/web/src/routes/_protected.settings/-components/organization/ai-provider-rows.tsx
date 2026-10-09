import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { PlusIcon, Trash2Icon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import {
  List,
  ListGroup,
  ListGroupHeader,
  ListGroupTitle,
  ListGroupDescription,
  ListItem,
} from "@stll/ui/list";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  createProviderCredentialDraft,
  getAvailableProviderKeys,
  getNextAvailableProvider,
  hasProviderCredentialChanges,
  isProviderValue,
  PROVIDER_LABELS,
} from "@/components/ai-config-role-models.logic";
import type {
  ProviderCredentialDraft,
  ProviderValue,
} from "@/components/ai-config-role-models.logic";
import { CopyActionButton } from "@/components/copy-action-button";
import { SecretInput } from "@/components/secret-input";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { providerSetupGuidance } from "@/lib/errors/provider-setup-guidance";
import { sanitizeHref } from "@/lib/sanitize-href";

export const AIProviderRows = ({
  providers,
  disabled,
  onChange,
  onSave,
  onRemove,
  storedProviders = EMPTY_PROVIDERS,
}: AIProviderRowsProps) => {
  const t = useTranslations("organization.aiConfig");
  return (
    <ListGroup>
      <ListGroupHeader>
        <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5">
          <ListGroupTitle>{t("providersPanel")}</ListGroupTitle>
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || getNextAvailableProvider(providers) === null}
            onClick={() => {
              const provider = getNextAvailableProvider(providers);
              if (provider) {
                onChange([
                  ...providers,
                  createProviderCredentialDraft(provider),
                ]);
              }
            }}
          >
            <PlusIcon />
            {t("addProvider")}
          </Button>
          <ListGroupDescription className="col-start-1">
            {t("providersDescription")}
          </ListGroupDescription>
        </div>
      </ListGroupHeader>
      <List>
        {providers.map((draft) => (
          <AIProviderRow
            key={draft.provider}
            draft={draft}
            disabled={disabled}
            removalImpact={
              storedProviders.filter((provider) => provider.apiKeyMasked)
                .length === 1
                ? "configuration"
                : "provider"
            }
            dirty={hasProviderCredentialChanges({
              draft,
              stored: storedProviders.find(
                (saved) => saved.provider === draft.provider,
              ),
            })}
            options={getAvailableProviderKeys({
              currentProvider: draft.provider,
              providers,
            })}
            onChange={(next) =>
              onChange(
                providers.map((candidate) =>
                  candidate.provider === draft.provider ? next : candidate,
                ),
              )
            }
            onSave={onSave}
            onRemove={onRemove}
          />
        ))}
      </List>
    </ListGroup>
  );
};

const EMPTY_PROVIDERS = [] as const;

const KEY_FORMATS = {
  google: /^AIza[A-Za-z0-9_-]{35}$/u,
  anthropic: /^sk-ant-(?:api\d+|usr)-[A-Za-z0-9_-]+$/u,
  openai: /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}$/u,
  openrouter: /^sk-or-v1-[A-Za-z0-9_-]{20,}$/u,
  mistral: /^[A-Za-z0-9]{32}$/u,
  bedrock: /^(?:ABSK|bedrock-api-key-)[A-Za-z0-9+/=_-]+$/u,
} as const satisfies Record<ProviderValue, RegExp>;

type RowState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "verified" }
  | {
      status: "error";
      message: string;
      code?: ProviderSetupErrorCode | undefined;
    };

type AIProviderRowsProps = {
  providers: ProviderCredentialDraft[];
  storedProviders?: readonly ProviderCredentialDraft[];
  disabled: boolean;
  onChange: (providers: ProviderCredentialDraft[]) => void;
  onSave: (provider: ProviderCredentialDraft) => Promise<void>;
  onRemove: (provider: ProviderCredentialDraft) => Promise<void>;
};

type AIProviderRowProps = {
  draft: ProviderCredentialDraft;
  removalImpact: "provider" | "configuration";
  dirty: boolean;
  disabled: boolean;
  options: ProviderValue[];
  onChange: (draft: ProviderCredentialDraft) => void;
  onSave: AIProviderRowsProps["onSave"];
  onRemove: AIProviderRowsProps["onRemove"];
};

function AIProviderRow({
  draft,
  removalImpact,
  dirty,
  disabled,
  options,
  onChange,
  onSave,
  onRemove,
}: AIProviderRowProps) {
  const t = useTranslations("organization.aiConfig");
  const common = useTranslations("common");
  const translate = useTranslations();
  const [state, setState] = useState<RowState>({ status: "idle" });
  const [removalState, setRemovalState] = useState<"idle" | "confirming">(
    "idle",
  );
  const editable = draft.replacingKey || !draft.apiKeyMasked;
  const pending = disabled || state.status === "saving";
  const guidance = providerSetupGuidance(
    state.status === "error" ? state.code : undefined,
  );
  const workspaceNeeded =
    draft.provider === "anthropic" &&
    (draft.apiKey.startsWith("sk-ant-usr-") ||
      draft.anthropicWorkspaceId !== undefined ||
      guidance?.field === "anthropicWorkspaceId");
  const change = (next: ProviderCredentialDraft) => {
    setState({ status: "idle" });
    onChange(next);
  };
  const save = async () => {
    setState({ status: "saving" });
    const result = await Result.tryPromise({
      try: async () => await onSave(draft),
      catch: (error: unknown) => error,
    });
    if (result.isErr()) {
      const error = result.error;
      setState({
        status: "error",
        message: providerRowErrorMessage(error, common("somethingWentWrong")),
        code: APIError.is(error)
          ? providerSetupGuidance(error.code)?.code
          : undefined,
      });
      return;
    }
    setState({ status: "verified" });
  };
  const remove = async () => {
    setRemovalState("idle");
    setState({ status: "saving" });
    const result = await Result.tryPromise({
      try: async () => await onRemove(draft),
      catch: (error: unknown) => error,
    });
    if (result.isErr()) {
      const error = result.error;
      setState({
        status: "error",
        message: APIError.is(error)
          ? (error.rawMessage ?? error.message)
          : common("somethingWentWrong"),
      });
      return;
    }
    setState({ status: "idle" });
  };
  return (
    <ListItem className="flex-col items-stretch">
      <form
        className="flex min-w-0 flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) {
            detached(save(), "ai-provider-row.save");
          }
        }}
      >
        {editable ? (
          <Select
            value={draft.provider}
            disabled={pending || draft.apiKeyMasked !== undefined}
            onValueChange={(value) => {
              if (isProviderValue(value)) {
                change(createProviderCredentialDraft(value));
              }
            }}
          >
            <SelectTrigger aria-label={t("provider")} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {options.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="w-36 text-sm font-medium">
            {PROVIDER_LABELS[draft.provider]}
          </span>
        )}
        <div className="min-w-36 flex-1">
          {editable ? (
            <SecretInput
              aria-label={t("apiKey")}
              autoComplete="off"
              disabled={pending}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!pending) {
                    detached(save(), "ai-provider-row.save");
                  }
                }
              }}
              value={draft.apiKey}
              onChange={(event) =>
                change({
                  ...draft,
                  apiKey: event.target.value,
                  replacingKey: true,
                })
              }
            />
          ) : (
            <bdi className="text-muted-foreground font-mono text-sm">
              {draft.apiKeyMasked}
            </bdi>
          )}
        </div>
        {editable ? (
          <Button
            type="submit"
            size="sm"
            loading={state.status === "saving"}
            disabled={pending}
          >
            {common("save")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => change({ ...draft, apiKey: "", replacingKey: true })}
          >
            {t("replaceKey")}
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("removeProvider")}
          disabled={pending}
          onClick={() => {
            if (draft.apiKeyMasked) {
              setRemovalState("confirming");
              return;
            }
            detached(remove(), "ai-provider-row.remove");
          }}
        >
          <Trash2Icon />
        </Button>
        {editable && workspaceNeeded && (
          <Input
            aria-label={t("anthropicWorkspaceId")}
            placeholder={t("anthropicWorkspaceId")}
            dir="ltr"
            autoComplete="off"
            disabled={pending}
            value={draft.anthropicWorkspaceId ?? ""}
            onChange={(event) =>
              change({ ...draft, anthropicWorkspaceId: event.target.value })
            }
          />
        )}
      </form>
      {editable &&
        draft.apiKey.trim().length > 0 &&
        !KEY_FORMATS[draft.provider].test(draft.apiKey.trim()) && (
          <p className="text-muted-foreground text-xs" role="note">
            {t("keyFormatHint", { provider: PROVIDER_LABELS[draft.provider] })}
          </p>
        )}
      {editable && dirty && (
        <p className="text-muted-foreground text-xs">
          {common("unsavedChanges")}
        </p>
      )}
      {state.status === "verified" && !editable && (
        <p role="status" className="text-muted-foreground text-xs">
          {t("savedVerified")}
        </p>
      )}
      {state.status === "error" && (
        <div
          role="alert"
          className="text-destructive flex min-w-0 items-start gap-2 text-sm"
        >
          <div
            dir="auto"
            className="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap"
          >
            {state.message}
            {guidance && (
              <p>
                {state.message !== translate(guidance.guidance) &&
                  translate(guidance.guidance)}{" "}
                <a
                  className="underline"
                  href={sanitizeHref(guidance.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {translate(guidance.linkLabel)}
                </a>
              </p>
            )}
          </div>
          <CopyActionButton text={state.message} />
        </div>
      )}
      <AlertDialog
        open={removalState === "confirming"}
        onOpenChange={(open) => setRemovalState(open ? "confirming" : "idle")}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{common("confirmAction")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                removalImpact === "configuration"
                  ? "removeLastProviderConfirm"
                  : "removeProviderConfirm",
                { provider: PROVIDER_LABELS[draft.provider] },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {common("cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => detached(remove(), "ai-provider-row.remove")}
            >
              {common("confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ListItem>
  );
}

function providerRowErrorMessage(error: unknown, fallback: string): string {
  if (APIError.is(error)) {
    return error.rawMessage ?? error.message;
  }
  return fallback;
}
