import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { AlarmClockIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SIGNAL_STATUS, SUGGESTION_KIND } from "@stll/api-contract/signals";
import type { SignalSuggestion } from "@stll/api-contract/signals";
import { UserText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { KanbanCardShell } from "@stll/ui/kanban";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/menu";
import {
  Popover,
  PopoverPanel,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  acceptSignal,
  assignSignal,
  type ClientSignalAcceptanceResult,
  dismissSignal,
  openSignalChat,
  snoozeSignal,
} from "@/components/inbox/signal-actions";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterRefLink } from "@/components/matter-ref-link";
import Tooltip from "@/components/tooltip";
import {
  INBOX_SIGNAL_VIEW,
  inboxSignalTabId,
} from "@/features/inbox/signal-inspector.logic";
import {
  ORIGIN_LABEL_KEY,
  scoutLabelKey,
  SEVERITY_DOT_CLASS,
  SEVERITY_LABEL_KEY,
  SUGGESTION_LABEL_KEY,
} from "@/features/inbox/signal-presentation";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { snoozeUntil } from "@/lib/inbox/inbox.logic";
import { inboxKeys } from "@/lib/inbox/queries";
import type { InboxSignal } from "@/lib/inbox/queries";
import { organizationOptions } from "@/lib/organization/queries";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { entityViewKeys } from "@/lib/workspaces/queries/entity-views";
import { myWorkKeys } from "@/lib/workspaces/queries/my-work";

type SignalCardProps = {
  signal: InboxSignal;
  organizationId: string;
  presentation?: "card" | "actions";
  onChanged?: () => Promise<void>;
};

export const SignalCard = ({
  signal,
  organizationId,
  presentation = "card",
  onChanged,
}: SignalCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const canResolve = usePermissions({ signal: ["resolve"] });
  const canChat = usePermissions({ chat: ["create"] });
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const isOpen =
    signal.status === SIGNAL_STATUS.NEW ||
    signal.status === SIGNAL_STATUS.SNOOZED;

  const run = async (
    operation: () => Promise<Result<unknown, unknown>>,
    successMessage: string | null,
    invalidateMyWork = false,
  ) => {
    setBusy(true);
    const result = await operation();
    if (Result.isError(result)) {
      setBusy(false);
      analytics.captureError(result.error);
      stellaToast.error(
        userErrorFromThrown(result.error, t("common.unexpectedError")),
      );
      return false;
    }
    if (successMessage !== null) {
      stellaToast.add({ title: successMessage, type: "success" });
    }
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: inboxKeys.all(organizationId),
      }),
      // Signals are rows of the shared views window.
      queryClient.invalidateQueries({
        queryKey: entityViewKeys.all(organizationId),
      }),
      ...(invalidateMyWork
        ? [queryClient.invalidateQueries({ queryKey: myWorkKeys.all })]
        : []),
    ]);
    await onChanged?.();
    setBusy(false);
    return true;
  };

  const mutationArgs = { signalId: signal.id };

  const openEvidence = () => {
    useInspectorTabsStore.getState().openView({
      type: INBOX_SIGNAL_VIEW,
      id: inboxSignalTabId(signal.id),
      label: signal.title,
      payload: { signalId: signal.id },
    });
  };

  const askAboutThis = () => {
    openSignalChat(
      signal,
      t("inbox.askPrompt", { title: signal.title, summary: signal.summary }),
    );
  };

  const accept = async (
    suggestionKind: SignalSuggestion["kind"],
    result?: ClientSignalAcceptanceResult,
  ) =>
    await run(
      async () =>
        await acceptSignal({
          ...mutationArgs,
          suggestionKind,
          ...(result ? { result } : {}),
        }),
      t("inspector.review.decisions.accepted"),
      true,
    );

  const assign = async (assigneeUserId: string) =>
    await run(async () => {
      const assigned = await assignSignal({
        ...mutationArgs,
        assigneeUserId,
      });
      if (Result.isError(assigned)) {
        return assigned;
      }
      return acceptSignal({
        ...mutationArgs,
        suggestionKind: SUGGESTION_KIND.ASSIGN,
      });
    }, t("inspector.review.decisions.accepted"));

  const dismiss = async (reason: string | null) =>
    await run(
      async () => await dismissSignal({ ...mutationArgs, reason }),
      null,
    );

  const scoutKey = scoutLabelKey(signal.scoutKey);
  const taskSuggestion = signal.suggestions.find(
    (suggestion) =>
      suggestion.kind === SUGGESTION_KIND.CREATE_TASK ||
      suggestion.kind === SUGGESTION_KIND.CREATE_DEADLINE,
  );

  const actions = isOpen && (canResolve || canChat) && (
    <div className="flex flex-wrap items-center gap-1.5">
      {canResolve && taskSuggestion && (
        <ReviewDecisionActions
          state={busy ? "applying" : "pending"}
          acceptLabel={t("common.accept")}
          rejectLabel={t("docxReview.reject")}
          acceptTooltip={t(SUGGESTION_LABEL_KEY[taskSuggestion.kind])}
          onAccept={() => {
            detached(accept(taskSuggestion.kind), "inbox.accept-proposal");
          }}
          onReject={() => {
            detached(dismiss(null), "inbox.refuse-proposal");
          }}
        />
      )}
      {canResolve &&
        !taskSuggestion &&
        signal.suggestions.map((suggestion) => (
          <SuggestionButton
            disabled={busy}
            key={suggestion.kind}
            onAccept={accept}
            onAssign={assign}
            onOpenChat={(prompt) => openSignalChat(signal, prompt)}
            organizationId={organizationId}
            suggestion={suggestion}
          />
        ))}
      <span className="flex-1" />
      {canChat && (
        <Button onClick={askAboutThis} size="sm" variant="muted">
          <MessageSquareIcon />
          {t("inbox.ask")}
        </Button>
      )}
      {canResolve && (
        <>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("inbox.snooze")}
                  disabled={busy}
                  size="sm"
                  variant="muted"
                />
              }
            >
              <AlarmClockIcon />
            </MenuTrigger>
            <MenuPopup>
              <MenuGroup>
                <MenuGroupLabel>{t("inbox.snooze")}</MenuGroupLabel>
                <MenuItem
                  onClick={() => {
                    detached(
                      run(
                        async () =>
                          await snoozeSignal({
                            ...mutationArgs,
                            until: snoozeUntil("tomorrow"),
                          }),
                        null,
                      ),
                      "inbox.snooze",
                    );
                  }}
                >
                  {t("inbox.snoozeTomorrow")}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    detached(
                      run(
                        async () =>
                          await snoozeSignal({
                            ...mutationArgs,
                            until: snoozeUntil("next-week"),
                          }),
                        null,
                      ),
                      "inbox.snooze",
                    );
                  }}
                >
                  {t("inbox.snoozeNextWeek")}
                </MenuItem>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          {!taskSuggestion && (
            <DismissPopover disabled={busy} onDismiss={dismiss} />
          )}
        </>
      )}
    </div>
  );

  if (presentation === "actions") {
    return actions;
  }

  return (
    <KanbanCardShell
      appearance={isOpen && taskSuggestion ? "proposal" : "standard"}
      className={cn(
        "text-card-foreground flex min-w-0 flex-col gap-3",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          aria-label={t(SEVERITY_LABEL_KEY[signal.severity])}
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            SEVERITY_DOT_CLASS[signal.severity],
          )}
          role="img"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button
            className="text-start text-sm leading-5 font-medium text-balance wrap-anywhere hover:underline"
            onClick={openEvidence}
            type="button"
          >
            <UserText>{signal.title}</UserText>
          </button>
          <UserText
            as="p"
            className="text-muted-foreground line-clamp-3 text-xs leading-5 text-pretty wrap-anywhere"
          >
            {signal.summary}
          </UserText>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <OriginChip
              createdByUserId={signal.createdByUserId}
              label={t(ORIGIN_LABEL_KEY[signal.origin])}
              organizationId={organizationId}
              origin={signal.origin}
              scoutLabel={scoutKey === null ? null : t(scoutKey)}
            />
            {signal.workspaceId !== null && (
              <>
                <span aria-hidden>·</span>
                <WorkspaceName
                  organizationId={organizationId}
                  workspaceId={signal.workspaceId}
                />
              </>
            )}
            <span aria-hidden>·</span>
            <Tooltip
              content={formatFullTimestamp(signal.createdAt)}
              render={<time dateTime={signal.createdAt} />}
            >
              {formatRelativeTime(signal.createdAt)}
            </Tooltip>
            {signal.status === SIGNAL_STATUS.SNOOZED &&
              signal.snoozedUntil !== null && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    {t("inbox.snoozedUntil", {
                      date: format.dateTime(new Date(signal.snoozedUntil), {
                        dateStyle: "medium",
                      }),
                    })}
                  </span>
                </>
              )}
            {signal.status === SIGNAL_STATUS.ACCEPTED && (
              <>
                <span aria-hidden>·</span>
                <span>{t("inspector.review.decisions.accepted")}</span>
              </>
            )}
            {signal.status === SIGNAL_STATUS.DISMISSED && (
              <>
                <span aria-hidden>·</span>
                <span>{t("inspector.review.decisions.dismissed")}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {actions}
    </KanbanCardShell>
  );
};

type OriginChipProps = {
  origin: InboxSignal["origin"];
  label: string;
  scoutLabel: string | null;
  createdByUserId: string | null;
  organizationId: string;
};

const OriginChip = ({
  origin,
  label,
  scoutLabel,
  createdByUserId,
  organizationId,
}: OriginChipProps) => {
  const { data: organization } = useQuery({
    ...organizationOptions(organizationId),
    enabled: origin === "manual" && createdByUserId !== null,
  });
  const author =
    origin === "manual" && createdByUserId !== null
      ? organization?.members.find((m) => m.userId === createdByUserId)?.user
          .name
      : undefined;

  return (
    <span className="bg-muted text-foreground-muted inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5">
      <span>{label}</span>
      {author !== undefined && (
        <span>
          · <UserText>{author}</UserText>
        </span>
      )}
      {origin === "source" && scoutLabel !== null && (
        <span>· {scoutLabel}</span>
      )}
    </span>
  );
};

const WorkspaceName = ({
  workspaceId,
  organizationId,
}: {
  workspaceId: string;
  organizationId: string;
}) => {
  const { data } = useQuery(workspacesNavigationOptions(organizationId));
  const name = data?.workspaces.find((w) => w.id === workspaceId)?.name;
  return (
    <MatterRefLink
      className="hover:text-foreground truncate underline-offset-2 hover:underline"
      workspaceId={workspaceId}
    >
      <UserText>{name ?? workspaceId}</UserText>
    </MatterRefLink>
  );
};

type SuggestionButtonProps = {
  suggestion: SignalSuggestion;
  organizationId: string;
  disabled: boolean;
  onAccept: (
    kind: SignalSuggestion["kind"],
    result?: ClientSignalAcceptanceResult,
  ) => Promise<boolean>;
  onAssign: (assigneeUserId: string) => Promise<boolean>;
  onOpenChat: (prompt: string) => void;
};

const SuggestionButton = ({
  suggestion,
  organizationId,
  disabled,
  onAccept,
  onAssign,
  onOpenChat,
}: SuggestionButtonProps) => {
  const t = useTranslations();
  const label = t(SUGGESTION_LABEL_KEY[suggestion.kind]);
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);

  switch (suggestion.kind) {
    case SUGGESTION_KIND.CREATE_TASK:
    case SUGGESTION_KIND.CREATE_DEADLINE:
      return (
        <Button
          disabled={disabled}
          onClick={() => {
            detached(onAccept(suggestion.kind), "inbox.accept");
          }}
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
      );
    case SUGGESTION_KIND.ASSIGN:
      return (
        <AssignMenu
          disabled={disabled}
          label={label}
          onAssign={onAssign}
          organizationId={organizationId}
        />
      );
    case SUGGESTION_KIND.PROMOTE_TO_WORKSPACE:
      return (
        <Button
          disabled={disabled}
          onClick={() => {
            openCreateMatter(undefined, async (workspaceId) => {
              await onAccept(suggestion.kind, {
                type: "workspace",
                workspaceId,
              });
            });
          }}
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
      );
    case SUGGESTION_KIND.OPEN_CHAT:
      return (
        <Button
          disabled={disabled}
          onClick={() => {
            onOpenChat(suggestion.prompt);
            detached(onAccept(suggestion.kind), "inbox.accept");
          }}
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
      );
    default: {
      suggestion satisfies never;
      return panic(`Unhandled suggestion: ${String(suggestion)}`);
    }
  }
};

type AssignMenuProps = {
  label: string;
  disabled: boolean;
  organizationId: string;
  onAssign: (assigneeUserId: string) => Promise<boolean>;
};

const AssignMenu = ({
  label,
  disabled,
  organizationId,
  onAssign,
}: AssignMenuProps) => {
  const t = useTranslations();
  const { data: organization } = useQuery(organizationOptions(organizationId));
  const members = organization ? organization.members : [];
  return (
    <Menu>
      <MenuTrigger
        render={<Button disabled={disabled} size="sm" variant="outline" />}
      >
        {label}
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("inbox.assignTo")}</MenuGroupLabel>
          {members.map((member) => (
            <MenuItem
              key={member.userId}
              onClick={() => {
                detached(onAssign(member.userId), "inbox.assign");
              }}
            >
              <UserText>{member.user.name}</UserText>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
};

type DismissPopoverProps = {
  disabled: boolean;
  onDismiss: (reason: string | null) => Promise<boolean>;
};

const DismissPopover = ({ disabled, onDismiss }: DismissPopoverProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("common.dismiss")}
            disabled={disabled}
            size="sm"
            variant="muted"
          />
        }
      >
        <XIcon />
      </PopoverTrigger>
      <PopoverPopup className="w-72">
        <PopoverPanel className="flex flex-col gap-2">
          <Textarea
            aria-label={t("inbox.dismissReason")}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("inbox.dismissReason")}
            rows={2}
            value={reason}
          />
          <div className="flex justify-end gap-1">
            <Button onClick={() => setOpen(false)} size="sm" variant="ghost">
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                detached(
                  (async () => {
                    const trimmed = reason.trim();
                    const ok = await onDismiss(trimmed === "" ? null : trimmed);
                    if (ok) {
                      setOpen(false);
                      setReason("");
                    }
                  })(),
                  "inbox.dismiss",
                );
              }}
              size="sm"
            >
              {t("common.dismiss")}
            </Button>
          </div>
        </PopoverPanel>
      </PopoverPopup>
    </Popover>
  );
};
