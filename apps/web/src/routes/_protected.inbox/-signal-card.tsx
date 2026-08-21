import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { AlarmClockIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SIGNAL_STATUS, SUGGESTION_KIND } from "@stll/api-contract/signals";
import type { SignalSuggestion } from "@stll/api-contract/signals";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import {
  Popover,
  PopoverPanel,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/popover";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { MatterRefLink } from "@/components/matter-ref-link";
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
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { snoozeUntil } from "@/lib/inbox/inbox.logic";
import type { InboxSignal } from "@/lib/inbox/queries";
import { organizationOptions } from "@/lib/organization/queries";
import { formatRelativeTime } from "@/lib/relative-time";
import { useCreateMatterStore } from "@/lib/workspaces/create-matter-store";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import {
  acceptSignal,
  assignSignal,
  dismissSignal,
  openSignalChat,
  snoozeSignal,
} from "@/routes/_protected.inbox/-signal-actions";

type SignalCardProps = {
  signal: InboxSignal;
  organizationId: string;
  /** Called once a mutation settles so the feed can drop the card. */
  onSettled: () => void;
};

export const SignalCard = ({
  signal,
  organizationId,
  onSettled,
}: SignalCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const isOpen =
    signal.status === SIGNAL_STATUS.NEW ||
    signal.status === SIGNAL_STATUS.SNOOZED;

  const run = async (
    operation: () => Promise<Result<unknown, unknown>>,
    successMessage: string | null,
  ) => {
    setBusy(true);
    const result = await operation();
    setBusy(false);
    if (Result.isError(result)) {
      analytics.captureError(result.error);
      stellaToast.error(
        userErrorFromThrown(result.error, t("common.unexpectedError")),
      );
      return false;
    }
    if (successMessage !== null) {
      stellaToast.add({ title: successMessage, type: "success" });
    }
    onSettled();
    return true;
  };

  const mutationArgs = { queryClient, organizationId, signalId: signal.id };

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

  const accept = async (suggestionKind: SignalSuggestion["kind"]) =>
    await run(
      async () => await acceptSignal({ ...mutationArgs, suggestionKind }),
      t("inspector.review.decisions.accepted"),
    );

  const scoutKey = scoutLabelKey(signal.scoutKey);

  return (
    <article
      className={cn(
        "group/card bg-card text-card-foreground flex flex-col gap-2 rounded-lg p-3 shadow-xs",
        "hover:shadow-sm motion-safe:transition-shadow motion-safe:duration-150",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-start gap-3">
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
            className="text-start text-sm font-medium text-balance hover:underline"
            onClick={openEvidence}
            type="button"
          >
            {signal.title}
          </button>
          <p className="text-muted-foreground line-clamp-2 text-sm text-pretty">
            {signal.summary}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <OriginChip
              confidence={signal.confidence}
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
            <time
              dateTime={signal.createdAt}
              title={format.dateTime(new Date(signal.createdAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            >
              {formatRelativeTime(signal.createdAt)}
            </time>
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

      {isOpen && (
        <div className="flex flex-wrap items-center gap-1.5 ps-5">
          {signal.suggestions.map((suggestion) => (
            <SuggestionButton
              disabled={busy}
              key={suggestion.kind}
              onAccept={accept}
              onAssign={async (assigneeUserId) =>
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
                }, t("inspector.review.decisions.accepted"))
              }
              onOpenChat={askAboutThis}
              organizationId={organizationId}
              suggestion={suggestion}
            />
          ))}
          <span className="flex-1" />
          <Button
            className="text-muted-foreground"
            onClick={askAboutThis}
            size="sm"
            variant="ghost"
          >
            <MessageSquareIcon />
            {t("inbox.ask")}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("inbox.snooze")}
                  className="text-muted-foreground"
                  disabled={busy}
                  size="sm"
                  variant="ghost"
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
          <DismissPopover
            disabled={busy}
            onDismiss={async (reason) =>
              await run(
                async () => await dismissSignal({ ...mutationArgs, reason }),
                null,
              )
            }
          />
        </div>
      )}
    </article>
  );
};

type OriginChipProps = {
  origin: InboxSignal["origin"];
  label: string;
  scoutLabel: string | null;
  confidence: number | null;
  createdByUserId: string | null;
  organizationId: string;
};

const OriginChip = ({
  origin,
  label,
  scoutLabel,
  confidence,
  createdByUserId,
  organizationId,
}: OriginChipProps) => {
  const t = useTranslations();
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
      {author !== undefined && <span>· {author}</span>}
      {origin === "source" && scoutLabel !== null && (
        <span>· {scoutLabel}</span>
      )}
      {origin === "model" && confidence !== null && (
        <span className="tabular-nums">
          · {t("inbox.confidence", { percent: Math.round(confidence * 100) })}
        </span>
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
      {name ?? workspaceId}
    </MatterRefLink>
  );
};

type SuggestionButtonProps = {
  suggestion: SignalSuggestion;
  organizationId: string;
  disabled: boolean;
  onAccept: (kind: SignalSuggestion["kind"]) => Promise<boolean>;
  onAssign: (assigneeUserId: string) => Promise<boolean>;
  onOpenChat: () => void;
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
    case SUGGESTION_KIND.FILE_TO_WORKSPACE:
      return (
        <MatterMenu
          disabled={disabled}
          label={label}
          onPick={async () => await onAccept(suggestion.kind)}
          organizationId={organizationId}
        />
      );
    case SUGGESTION_KIND.PROMOTE_TO_WORKSPACE:
      return (
        <Button
          disabled={disabled}
          onClick={() => {
            openCreateMatter();
            detached(onAccept(suggestion.kind), "inbox.accept");
          }}
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
      );
    case SUGGESTION_KIND.RUN_REVIEW:
    case SUGGESTION_KIND.OPEN_CHAT:
      return (
        <Button
          disabled={disabled}
          onClick={() => {
            onOpenChat();
            detached(onAccept(suggestion.kind), "inbox.accept");
          }}
          size="sm"
          variant="outline"
        >
          {label}
        </Button>
      );
    default: {
      const exhaustive: never = suggestion;
      return exhaustive;
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
  const members = organization?.members ?? [];
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
              {member.user.name}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
};

type MatterMenuProps = {
  label: string;
  disabled: boolean;
  organizationId: string;
  onPick: (workspaceId: string) => Promise<boolean>;
};

const MatterMenu = ({
  label,
  disabled,
  organizationId,
  onPick,
}: MatterMenuProps) => {
  const t = useTranslations();
  const { data } = useQuery(workspacesNavigationOptions(organizationId));
  const workspaces = data?.workspaces ?? [];
  return (
    <Menu>
      <MenuTrigger
        render={<Button disabled={disabled} size="sm" variant="outline" />}
      >
        {label}
      </MenuTrigger>
      <MenuPopup>
        <MenuGroup>
          <MenuGroupLabel>{t("common.selectAMatter")}</MenuGroupLabel>
          {workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              onClick={() => {
                detached(onPick(workspace.id), "inbox.file");
              }}
            >
              {workspace.name}
            </MenuItem>
          ))}
        </MenuGroup>
        {workspaces.length === 0 && (
          <>
            <MenuSeparator />
            <MenuItem disabled>{t("common.noResults")}</MenuItem>
          </>
        )}
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
            aria-label={t("inspector.review.dismiss")}
            className="text-muted-foreground"
            disabled={disabled}
            size="sm"
            variant="ghost"
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
              {t("inspector.review.dismiss")}
            </Button>
          </div>
        </PopoverPanel>
      </PopoverPopup>
    </Popover>
  );
};
