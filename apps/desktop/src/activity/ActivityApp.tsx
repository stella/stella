import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EyeOffIcon,
  LockKeyholeIcon,
  PauseIcon,
  PlayIcon,
  ShieldAlertIcon,
  Trash2Icon,
  XIcon,
} from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import {
  appTotals,
  calendarDate,
  durationParts,
  proposeBlocks,
  shiftDate,
  timedSegments,
  topAppNames,
  totalDurationMs,
} from "./activity-logic";
import type { ActivityBlock, TimedSegment } from "./activity-logic";
import {
  ACTIVITY_CHANGED_EVENT,
  ACTIVITY_RETENTIONS,
  isActivityDaySnapshot,
} from "./activity-types";
import type {
  ActivityAppExclusion,
  ActivityDaySnapshot,
  ActivityRetention,
} from "./activity-types";

type ActivityView =
  | { type: "loading" }
  | { type: "failed" }
  | { snapshot: ActivityDaySnapshot; type: "ready" };

type ActivityDialog =
  | { type: "closed" }
  | { date: string; type: "deleteDay" }
  | { type: "deleteAll" }
  | { app: ActivityAppExclusion; type: "excludeApp" };

type ActivityCommand =
  | "activity_copy_text"
  | "activity_delete_all"
  | "activity_delete_day"
  | "activity_exclude_app"
  | "activity_remove_app_exclusion"
  | "activity_set_recording_status"
  | "activity_set_retention";

type RunCommand = (
  command: ActivityCommand,
  args?: Record<string, unknown>,
  onSuccess?: () => void,
) => void;

const RETENTION_LABEL_KEYS = {
  month: "retentionMonth",
  quarter: "retentionQuarter",
  week: "retentionWeek",
} as const satisfies Record<ActivityRetention, string>;

const reportActivityError = (
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[
    | "activityRead"
    | "activitySubscribe"
    | "activityUpdate"],
  code: (typeof DESKTOP_TELEMETRY_ERROR_CODES)[
    | "eventSubscriptionFailed"
    | "invalidResponse"
    | "invokeFailed"],
) => {
  // Fixed codes only: nothing about what was recorded leaves the window.
  reportDesktopError({
    code,
    operation,
    window: DESKTOP_TELEMETRY_WINDOWS.activity,
  });
};

const ActivityShell = ({ children }: React.PropsWithChildren) => {
  const t = useTranslations("activity");
  return (
    <main className="bg-background text-foreground min-h-dvh">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 pt-10 pb-8">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {children}
      </div>
    </main>
  );
};

const ErrorLine = ({ message }: { message: string }) => (
  <p className="text-destructive text-sm" role="alert">
    {message}
  </p>
);

const ActivityWelcome = ({ onStart }: { onStart: () => void }) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4 rounded-2xl border p-6">
      <h2 className="text-base font-semibold">{t("welcomeTitle")}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("welcomeDescription")}
      </p>
      <div className="flex gap-3">
        <LockKeyholeIcon
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
        />
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">{t("welcomeLocalTitle")}</h3>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("welcomeLocalDescription")}
          </p>
        </div>
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("welcomeControlDescription")}
      </p>
      <div>
        <Button onClick={onStart}>{t("welcomeStart")}</Button>
      </div>
    </section>
  );
};

const DeletionOnlyNotice = ({ onDelete }: { onDelete: () => void }) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex gap-3">
        <ShieldAlertIcon
          aria-hidden="true"
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <p className="text-sm leading-relaxed">{t("deletionOnly")}</p>
      </div>
      <div>
        <Button onClick={onDelete} variant="destructive">
          {t("deleteAll")}
        </Button>
      </div>
    </section>
  );
};

type DayHeaderProps = {
  onNavigate: (date: string) => void;
  onToggleRecording: () => void;
  snapshot: ActivityDaySnapshot;
};

const DayHeader = ({
  onNavigate,
  onToggleRecording,
  snapshot,
}: DayHeaderProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const recording = snapshot.recordingStatus === "recording";
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label={t("dayNavigation")} className="flex items-center gap-1">
        <Button
          aria-label={t("previousDay")}
          disabled={snapshot.date <= snapshot.earliestDate}
          onClick={() => onNavigate(shiftDate(snapshot.date, -1))}
          size="icon"
          variant="ghost"
        >
          <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
        </Button>
        <h2 className="min-w-48 text-center text-sm font-medium">
          {format.dateTime(calendarDate(snapshot.date), { dateStyle: "full" })}
        </h2>
        <Button
          aria-label={t("nextDay")}
          disabled={snapshot.date >= snapshot.today}
          onClick={() => onNavigate(shiftDate(snapshot.date, 1))}
          size="icon"
          variant="ghost"
        >
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
        </Button>
        {snapshot.date === snapshot.today ? null : (
          <Button onClick={() => onNavigate(snapshot.today)} variant="ghost">
            {t("today")}
          </Button>
        )}
      </nav>
      <div className="flex items-center gap-3">
        <PersistenceBadge snapshot={snapshot} />
        <Button onClick={onToggleRecording} variant="outline">
          {recording ? (
            <PauseIcon aria-hidden="true" />
          ) : (
            <PlayIcon aria-hidden="true" />
          )}
          {recording ? t("pause") : t("resume")}
        </Button>
      </div>
    </header>
  );
};

const PersistenceBadge = ({ snapshot }: { snapshot: ActivityDaySnapshot }) => {
  const t = useTranslations("activity");
  const status =
    snapshot.recordingStatus === "recording" ? t("recording") : t("paused");
  if (snapshot.persistence === "memoryOnly") {
    return (
      <span className="text-muted-foreground text-xs">
        {status} · {t("memoryOnly")}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground flex items-center gap-1 text-xs">
      <LockKeyholeIcon aria-hidden="true" className="size-3" />
      {status} · {t("encrypted")}
    </span>
  );
};

type DayContentProps = {
  onCommand: RunCommand;
  onExclude: (app: ActivityAppExclusion) => void;
  snapshot: ActivityDaySnapshot;
};

const DayContent = ({ onCommand, onExclude, snapshot }: DayContentProps) => {
  const t = useTranslations("activity");
  if (snapshot.unreadable) {
    return (
      <p className="text-muted-foreground text-sm">{t("unreadableDay")}</p>
    );
  }
  const segments = timedSegments(snapshot.segments);
  if (segments.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("empty")}</p>;
  }
  return (
    <>
      <section className="flex flex-col gap-1">
        <h3 className="text-muted-foreground text-xs font-medium">
          {t("totalActive")}
        </h3>
        <p className="text-2xl font-semibold tabular-nums">
          <Duration durationMs={totalDurationMs(segments)} />
        </p>
      </section>
      <ProposedBlocks
        date={snapshot.date}
        onCommand={onCommand}
        segments={segments}
      />
      <AppTotals onExclude={onExclude} segments={segments} />
      <SegmentList segments={segments} />
    </>
  );
};

const Duration = ({ durationMs }: { durationMs: number }) => {
  const t = useTranslations("activity");
  const { hours, minutes } = durationParts(durationMs);
  if (hours > 0) {
    return t("durationHoursMinutes", { hours, minutes });
  }
  if (minutes > 0) {
    return t("durationMinutes", { minutes });
  }
  return t("durationUnderMinute");
};

const useTimeRange = () => {
  const format = useFormatter();
  return (startMs: number, endMs: number) =>
    format.dateTimeRange(new Date(startMs), new Date(endMs), {
      hour: "2-digit",
      minute: "2-digit",
    });
};

type ProposedBlocksProps = {
  date: string;
  onCommand: RunCommand;
  segments: readonly TimedSegment[];
};

const ProposedBlocks = ({ date, onCommand, segments }: ProposedBlocksProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const timeRange = useTimeRange();
  const [copiedStartMs, setCopiedStartMs] = useState<number | null>(null);
  const hours = (block: ActivityBlock) =>
    format.number(block.roundedTenths / 10, {
      maximumFractionDigits: 1,
      minimumFractionDigits: 1,
    });
  const summary = (block: ActivityBlock) =>
    t("blockSummary", {
      apps: format.list(topAppNames(block), { type: "conjunction" }),
      date: format.dateTime(calendarDate(date), { dateStyle: "medium" }),
      hours: hours(block),
      time: timeRange(block.startMs, block.endMs),
    });
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{t("proposedBlocks")}</h3>
        <p className="text-muted-foreground text-xs">
          {t("proposedBlocksDescription")}
        </p>
      </div>
      <ul className="flex flex-col divide-y rounded-xl border">
        {proposeBlocks(segments).map((block) => (
          <li className="flex items-center gap-3 px-4 py-3" key={block.startMs}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium tabular-nums">
                {timeRange(block.startMs, block.endMs)} ·{" "}
                {t("hours", { hours: hours(block) })}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {format.list(topAppNames(block), { type: "conjunction" })}
              </span>
            </div>
            <Button
              onClick={() =>
                onCommand("activity_copy_text", { text: summary(block) }, () =>
                  setCopiedStartMs(block.startMs),
                )
              }
              size="sm"
              variant="ghost"
            >
              <CopyIcon aria-hidden="true" />
              {copiedStartMs === block.startMs ? t("copied") : t("copySummary")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

type AppTotalsProps = {
  onExclude: (app: ActivityAppExclusion) => void;
  segments: readonly TimedSegment[];
};

const AppTotals = ({ onExclude, segments }: AppTotalsProps) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("byApp")}</h3>
      <ul className="flex flex-col divide-y rounded-xl border">
        {appTotals(segments).map((app) => (
          <li
            className="flex items-center gap-3 px-4 py-2"
            key={app.identifier}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{app.name}</span>
            <span className="text-muted-foreground text-sm tabular-nums">
              <Duration durationMs={app.durationMs} />
            </span>
            <Button
              aria-label={t("excludeApp", { name: app.name })}
              onClick={() =>
                onExclude({
                  identifier: app.identifier,
                  name: app.name,
                })
              }
              size="icon"
              title={t("excludeApp", { name: app.name })}
              variant="ghost"
            >
              <EyeOffIcon aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};

const SegmentList = ({ segments }: { segments: readonly TimedSegment[] }) => {
  const t = useTranslations("activity");
  const timeRange = useTimeRange();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("timeline")}</h3>
      <ol className="flex flex-col divide-y rounded-xl border">
        {segments.map((segment) => (
          <li
            className="flex items-center gap-3 px-4 py-2 text-sm"
            key={`${segment.startMs}-${segment.appIdentifier}`}
          >
            <span className="text-muted-foreground w-32 shrink-0 tabular-nums">
              {timeRange(segment.startMs, segment.endMs)}
            </span>
            <span className="min-w-0 flex-1 truncate">{segment.appName}</span>
            <span className="text-muted-foreground tabular-nums">
              <Duration durationMs={segment.endMs - segment.startMs} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
};

type ActivitySettingsProps = {
  onCommand: RunCommand;
  onDeleteAll: () => void;
  onDeleteDay: () => void;
  snapshot: ActivityDaySnapshot;
};

const ActivitySettings = ({
  onCommand,
  onDeleteAll,
  onDeleteDay,
  snapshot,
}: ActivitySettingsProps) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4 border-t pt-6">
      <h3 className="text-sm font-semibold">{t("settings")}</h3>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm" id="activity-retention-label">
          {t("retention")}
        </span>
        <Select
          onValueChange={(retention) => {
            onCommand("activity_set_retention", { retention });
          }}
          value={snapshot.retention}
        >
          <SelectTrigger
            aria-labelledby="activity-retention-label"
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {ACTIVITY_RETENTIONS.map((retention) => (
              <SelectItem key={retention} value={retention}>
                {t(RETENTION_LABEL_KEYS[retention])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm">{t("excludedApps")}</span>
        {snapshot.excludedApps.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("noExclusions")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {snapshot.excludedApps.map((app) => (
              <li
                className="bg-muted flex items-center gap-1 rounded-full py-0.5 ps-3 pe-1 text-xs"
                key={app.identifier}
              >
                {app.name}
                <Button
                  aria-label={t("removeExclusion", { name: app.name })}
                  onClick={() =>
                    onCommand("activity_remove_app_exclusion", {
                      identifier: app.identifier,
                    })
                  }
                  size="icon-xs"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onDeleteDay} variant="outline">
          <Trash2Icon aria-hidden="true" />
          {t("deleteDay")}
        </Button>
        <Button onClick={onDeleteAll} variant="destructive">
          <Trash2Icon aria-hidden="true" />
          {t("deleteAll")}
        </Button>
      </div>
    </section>
  );
};

type ActivityDialogViewProps = {
  dialog: ActivityDialog;
  onClose: () => void;
  onCommand: RunCommand;
};

const ActivityDialogView = ({
  dialog,
  onClose,
  onCommand,
}: ActivityDialogViewProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  switch (dialog.type) {
    case "closed":
      return null;
    case "deleteDay":
      return (
        <ConfirmDialog
          description={t("deleteDayConfirmation", {
            date: format.dateTime(calendarDate(dialog.date), {
              dateStyle: "long",
            }),
          })}
          onClose={onClose}
          onConfirm={() =>
            onCommand("activity_delete_day", { date: dialog.date }, onClose)
          }
          title={t("deleteDay")}
        />
      );
    case "excludeApp":
      return (
        <ConfirmDialog
          confirmLabel={t("deleteHistory")}
          description={t("excludeAppConfirmation", { name: dialog.app.name })}
          onClose={onClose}
          onConfirm={() =>
            onCommand(
              "activity_exclude_app",
              { ...dialog.app, history: "delete" },
              onClose,
            )
          }
          onKeep={() =>
            onCommand(
              "activity_exclude_app",
              { ...dialog.app, history: "keep" },
              onClose,
            )
          }
          title={t("excludeApp", { name: dialog.app.name })}
        />
      );
    case "deleteAll":
      return (
        <ConfirmDialog
          description={t("deleteAllConfirmation")}
          onClose={onClose}
          onConfirm={() => onCommand("activity_delete_all", {}, onClose)}
          title={t("deleteAll")}
        />
      );
    default:
      dialog satisfies never;
      return panic("Unhandled activity dialog");
  }
};

type ConfirmDialogProps = {
  confirmLabel?: string;
  onKeep?: () => void;
  description: string;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
};

const ConfirmDialog = ({
  confirmLabel,
  onKeep,
  description,
  onClose,
  onConfirm,
  title,
}: ConfirmDialogProps) => {
  const t = useTranslations("activity");
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogPopup className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            {t("cancel")}
          </DialogClose>
          {onKeep ? (
            <Button onClick={onKeep} variant="outline">
              {t("keepHistory")}
            </Button>
          ) : null}
          <Button onClick={onConfirm} variant="destructive">
            {confirmLabel ?? t("delete")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

const ActivityApp = () => {
  const t = useTranslations("activity");
  const [date, setDate] = useState<string | null>(null);
  const [view, setView] = useState<ActivityView>({ type: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ActivityDialog>({ type: "closed" });
  const requestId = useRef(0);
  const errorRead = t("errorRead");

  useEffect(() => {
    let disposed = false;
    const readDay = () => {
      requestId.current += 1;
      const current = requestId.current;
      invoke<unknown>("activity_get_day", { date })
        .then((value) => {
          if (disposed || current !== requestId.current) {
            return undefined;
          }
          if (!isActivityDaySnapshot(value)) {
            reportActivityError(
              DESKTOP_TELEMETRY_OPERATIONS.activityRead,
              DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse,
            );
            setView({ type: "failed" });
            return undefined;
          }
          setView({ snapshot: value, type: "ready" });
          return undefined;
        })
        .catch(() => {
          if (disposed || current !== requestId.current) {
            return;
          }
          reportActivityError(
            DESKTOP_TELEMETRY_OPERATIONS.activityRead,
            DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
          );
          setView({ type: "failed" });
        });
    };
    readDay();
    const stopListening = subscribeDesktopEvent({
      event: ACTIVITY_CHANGED_EVENT,
      handler: readDay,
      onError: () => {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activitySubscribe,
          DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
        );
      },
      onSubscribed: readDay,
    });
    return () => {
      disposed = true;
      stopListening();
    };
  }, [date]);

  const runCommand = (
    command: ActivityCommand,
    args: Record<string, unknown> = {},
    onSuccess?: () => void,
  ) => {
    setError(null);
    invoke(command, args)
      .then(() => {
        onSuccess?.();
        return undefined;
      })
      .catch(() => {
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        setError(
          command === "activity_copy_text" ? t("errorCopy") : t("errorUpdate"),
        );
      });
  };

  switch (view.type) {
    case "loading":
      return <main className="bg-background min-h-dvh" />;
    case "failed":
      return (
        <ActivityShell>
          <p className="text-muted-foreground text-sm" role="alert">
            {errorRead}
          </p>
        </ActivityShell>
      );
    case "ready":
      break;
    default:
      view satisfies never;
      return panic("Unhandled activity view");
  }

  const { snapshot } = view;
  if (snapshot.persistence === "initializing") {
    // The store announces itself with a change event once it is open.
    return <main className="bg-background min-h-dvh" />;
  }
  if (snapshot.persistence === "deletionOnly") {
    return (
      <ActivityShell>
        <DeletionOnlyNotice onDelete={() => setDialog({ type: "deleteAll" })} />
        <ActivityDialogView
          dialog={dialog}
          onClose={() => setDialog({ type: "closed" })}
          onCommand={runCommand}
        />
      </ActivityShell>
    );
  }
  if (snapshot.recordingStatus === "off") {
    return (
      <ActivityShell>
        <ActivityWelcome
          onStart={() =>
            runCommand("activity_set_recording_status", {
              status: "recording",
            })
          }
        />
        {error ? <ErrorLine message={error} /> : null}
      </ActivityShell>
    );
  }

  return (
    <ActivityShell>
      <DayHeader
        onNavigate={setDate}
        onToggleRecording={() =>
          runCommand("activity_set_recording_status", {
            status:
              snapshot.recordingStatus === "recording" ? "paused" : "recording",
          })
        }
        snapshot={snapshot}
      />
      {error ? <ErrorLine message={error} /> : null}
      <DayContent
        onCommand={runCommand}
        onExclude={(app) => setDialog({ app, type: "excludeApp" })}
        snapshot={snapshot}
      />
      <ActivitySettings
        onCommand={runCommand}
        onDeleteAll={() => setDialog({ type: "deleteAll" })}
        onDeleteDay={() =>
          setDialog({ date: snapshot.date, type: "deleteDay" })
        }
        snapshot={snapshot}
      />
      <ActivityDialogView
        dialog={dialog}
        onClose={() => setDialog({ type: "closed" })}
        onCommand={runCommand}
      />
    </ActivityShell>
  );
};

export default ActivityApp;
