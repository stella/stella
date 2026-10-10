import { useState } from "react";

import { useTranslations } from "use-intl";

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
import { SecretInput } from "@/components/secret-input";
import { providerSetupGuidance } from "@/lib/errors/provider-setup-guidance";

export const AIProviderRows = ({
  providers,
  disabled,
  onChange,
  onRemove,
  storedProviders = EMPTY_PROVIDERS,
  setupErrorCode,
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
            setupErrorCode={setupErrorCode}
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

type AIProviderRowsProps = {
  providers: ProviderCredentialDraft[];
  storedProviders?: readonly ProviderCredentialDraft[];
  disabled: boolean;
  setupErrorCode?: string | undefined;
  onChange: (providers: ProviderCredentialDraft[]) => void;
  onRemove: (provider: ProviderCredentialDraft) => void;
};

type AIProviderRowProps = {
  draft: ProviderCredentialDraft;
  removalImpact: "provider" | "configuration";
  dirty: boolean;
  disabled: boolean;
  options: ProviderValue[];
  setupErrorCode?: string | undefined;
  onChange: (draft: ProviderCredentialDraft) => void;
  onRemove: AIProviderRowsProps["onRemove"];
};

function AIProviderRow({
  draft,
  removalImpact,
  dirty,
  disabled,
  options,
  setupErrorCode,
  onChange,
  onRemove,
}: AIProviderRowProps) {
  const t = useTranslations("organization.aiConfig");
  const common = useTranslations("common");
  const [removalState, setRemovalState] = useState<"idle" | "confirming">(
    "idle",
  );
  const editable = draft.replacingKey || !draft.apiKeyMasked;
  const workspaceNeeded =
    draft.provider === "anthropic" &&
    (draft.apiKey.startsWith("sk-ant-usr-") ||
      draft.anthropicWorkspaceId !== undefined ||
      providerSetupGuidance(setupErrorCode)?.field === "anthropicWorkspaceId");
  const remove = () => {
    setRemovalState("idle");
    onRemove(draft);
  };
  return (
    <ListItem className="flex-col items-stretch">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {editable ? (
          <Select
            value={draft.provider}
            disabled={disabled || draft.apiKeyMasked !== undefined}
            onValueChange={(value) => {
              if (isProviderValue(value)) {
                onChange(createProviderCredentialDraft(value));
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
              disabled={disabled}
              value={draft.apiKey}
              onChange={(event) =>
                onChange({
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
        {!editable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() =>
              onChange({ ...draft, apiKey: "", replacingKey: true })
            }
          >
            {t("replaceKey")}
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={t("removeProvider")}
          disabled={disabled}
          onClick={() => {
            if (draft.apiKeyMasked) {
              setRemovalState("confirming");
              return;
            }
            remove();
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
            disabled={disabled}
            value={draft.anthropicWorkspaceId ?? ""}
            onChange={(event) =>
              onChange({ ...draft, anthropicWorkspaceId: event.target.value })
            }
          />
        )}
      </div>
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
            <Button variant="destructive" disabled={disabled} onClick={remove}>
              {common("confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ListItem>
  );
}
