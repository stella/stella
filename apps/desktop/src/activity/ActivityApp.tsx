import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { DayCalendar } from "@stll/ui/day-calendar";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  LockKeyholeIcon,
  PauseIcon,
  PlayIcon,
  Settings2Icon,
  ShieldAlertIcon,
} from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { PreviewPane } from "@stll/ui/preview-pane";

import type { ClipboardSourceAppVisual } from "../clipboard/clipboard-types";
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
  shiftDate,
} from "./activity-logic";
import type { TimedSegment } from "./activity-logic";
import { DELETION_ONLY_NOTICE } from "./activity-notices";
import {
  ACTIVITY_CHANGED_EVENT,
  isActivityDaySnapshot,
} from "./activity-types";
import type { ActivityDaySnapshot } from "./activity-types";
import { CaptureDetailsControl } from "./ActivityCaptureDetails";
import type { CaptureDetailsCommand } from "./ActivityCaptureDetails";
import "./activity-calendar.css";
import { ActivityDayCalendar } from "./ActivityDayCalendar";
import type {
  ActivityCalendarPreferences,
  ActivityReviewStatus,
} from "./ActivityDayCalendar";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import "./welcome-preview.css";
import previewApps from "./preview-apps.json" with { type: "json" };

type ActivityView =
  | { type: "loading" }
  | { type: "failed" }
  | { snapshot: ActivityDaySnapshot; type: "ready" };

type ActivityCommand =
  | CaptureDetailsCommand
  | "activity_copy_text"
  | "activity_open_settings"
  | "activity_set_recording_status";

type RunCommand = (
  command: ActivityCommand,
  args?: Record<string, unknown>,
  onSuccess?: () => void,
  onFailure?: () => void,
) => void;

const reportActivityError = (
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[
    "activityRead" | "activitySubscribe" | "activityUpdate"],
  code: (typeof DESKTOP_TELEMETRY_ERROR_CODES)[
    "eventSubscriptionFailed" | "invalidResponse" | "invokeFailed"],
) => {
  // Fixed codes only: nothing about what was recorded leaves the window.
  reportDesktopError({
    code,
    operation,
    window: DESKTOP_TELEMETRY_WINDOWS.activity,
  });
};

const ActivityShell = ({ children }: React.PropsWithChildren) => (
  <main className="bg-background text-foreground min-h-dvh">
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 pt-10 pb-8">
      {children}
    </div>
  </main>
);

const ErrorLine = ({ message }: { message: string }) => (
  <p className="text-destructive text-sm" role="alert">
    {message}
  </p>
);

const PREVIEW_DATE = "2026-10-08";

const ActivityWelcomePreview = ({
  snapshot,
}: {
  snapshot: ActivityDaySnapshot;
}) => {
  const t = useTranslations("activity");
  const locale = useLocale();
  const timeZone = Temporal.Now.timeZoneId();
  const startMs = Temporal.PlainDate.from(PREVIEW_DATE).toZonedDateTime({
    plainTime: "09:00",
    timeZone,
  }).epochMilliseconds;
  const matter = {
    id: "riverside-lease",
    name: t("welcomePreviewMatter"),
    reference: null,
    color: "--option-emerald",
    clientName: null,
    signals: {
      lastWorkedAt: null,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  };
  let cursor = startMs;
  const segments: TimedSegment[] = [];
  for (const { appIdentifier, appName, minutes } of previewApps) {
    const segmentStartMs = cursor;
    cursor += minutes * 60_000;
    segments.push({
      appIdentifier,
      appName,
      startMs: segmentStartMs,
      endMs: cursor,
      matterId: matter.id,
      document: null,
      windowTitle: null,
      call: false,
    });
  }
  const newest = segments.at(-1);
  if (!newest) {
    return panic("The activity preview must contain sample apps");
  }
  return (
    <PreviewPane
      aria-hidden="true"
      inert
      data-activity-preview=""
      className="pointer-events-none w-full p-0 [&>div]:h-auto [&>div]:p-4"
    >
      <div className="flex flex-col gap-4">
        <DayCalendar
          ariaLabel={t("title")}
          columns={[
            {
              blocks: segments.map((segment) => ({
                accessibleLabel: segment.appName,
                endMs: segment.endMs,
                id: segment.appIdentifier,
                kind: "segment",
                startMs: segment.startMs,
                title: (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ActivitySourceIcon
                      appIdentifier={segment.appIdentifier}
                      sourceAppVisuals={snapshot.sourceAppVisuals}
                    />
                    <bdi className="truncate">{segment.appName}</bdi>
                  </span>
                ),
                tone: {
                  color: matter.color,
                  matterId: matter.id,
                  type: "matter",
                },
              })),
              id: "activity",
              label: t("title"),
              rangeSelection: { type: "disabled" },
              type: "blocks",
            },
            {
              blocks: [
                {
                  accessibleLabel: matter.name,
                  endMs: cursor,
                  id: "entry",
                  kind: "entry",
                  startMs,
                  state: "suggestion",
                  onActivate: () =>
                    panic("Static activity previews cannot open suggestions"),
                  title: matter.name,
                  tone: {
                    color: matter.color,
                    matterId: matter.id,
                    type: "matter",
                  },
                },
              ],
              id: "entries",
              label: t("timeEntries"),
              rangeSelection: { type: "disabled" },
              type: "blocks",
            },
          ]}
          date={PREVIEW_DATE}
          granularity={15}
          hours={{ endHour: 10, startHour: 9 }}
          locale={locale}
          nowMs={startMs - 1}
          onSelectRange={() =>
            panic("Static activity previews cannot select ranges")
          }
          selection={null}
          timeZone={timeZone}
        />
        <div data-activity-preview-totals="">
          <AppTotals
            segments={segments}
            sourceAppVisuals={snapshot.sourceAppVisuals}
            sampleDuration={{
              identifier: newest.appIdentifier,
              durationMs: newest.endMs - newest.startMs - 60_000,
            }}
          />
        </div>
        <div
          data-activity-preview-matter=""
          className="flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium"
        >
          <MatterIcon matter={matter} className="size-4 shrink-0" />
          <bdi>{matter.name}</bdi>
          <span className="text-muted-foreground ms-auto text-sm font-normal tabular-nums">
            <Duration durationMs={cursor - startMs} />
          </span>
        </div>
      </div>
    </PreviewPane>
  );
};

type ActivityWelcomeProps = {
  onStart: () => void;
  onCommand: RunCommand;
  snapshot: ActivityDaySnapshot;
};

const ActivityWelcome = ({
  onStart,
  onCommand,
  snapshot,
}: ActivityWelcomeProps) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4 rounded-2xl border p-6">
      <h2 className="text-base font-semibold">{t("welcomeTitle")}</h2>
      <ActivityWelcomePreview snapshot={snapshot} />

      <ul className="text-muted-foreground flex flex-col gap-2 text-sm">
        <li className="flex items-center gap-2">
          <LockKeyholeIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("welcomeLocalFact")}
        </li>
        <li className="flex items-center gap-2">
          <EyeOffIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("welcomePrivacyFact")}
        </li>
        <li className="flex items-center gap-2">
          <PauseIcon aria-hidden="true" className="size-4 shrink-0" />
          {t("welcomeControlFact")}
        </li>
      </ul>
      <details className="text-muted-foreground text-xs">
        <summary className="flex min-h-11 cursor-pointer items-center">
          {t("welcomeLearnMore")}
        </summary>
        <p className="leading-relaxed text-pretty">{t("welcomeDetails")}</p>
      </details>
      <CaptureDetailsControl
        onCommand={onCommand}
        settings={snapshot}
        description="collapsed"
      />
      <div>
        <Button onClick={onStart}>{t("welcomeStart")}</Button>
      </div>
    </section>
  );
};

/** Saved activity that cannot be opened; recovery lives in the settings. */
const DeletionOnlyNotice = ({
  keyStatus,
  onOpenSettings,
}: {
  keyStatus: ActivityDaySnapshot["deletionStatus"];
  onOpenSettings: () => void;
}) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex gap-3">
        <ShieldAlertIcon
          aria-hidden="true"
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <p className="text-sm leading-relaxed">
          {t(DELETION_ONLY_NOTICE[keyStatus])}
        </p>
      </div>
      <div>
        <OpenSettingsButton onOpen={onOpenSettings} />
      </div>
    </section>
  );
};

const OpenSettingsButton = ({ onOpen }: { onOpen: () => void }) => {
  const t = useTranslations("activity");
  return (
    <Button onClick={onOpen} variant="outline">
      <Settings2Icon aria-hidden="true" />
      {t("settings")}
    </Button>
  );
};

type DayHeaderProps = {
  onNavigate: (date: string) => void;
  onToggleRecording: () => void;
  snapshot: ActivityDaySnapshot;
  navigationDisabled: boolean;
};

const DayHeader = ({
  onNavigate,
  onToggleRecording,
  snapshot,
  navigationDisabled,
}: DayHeaderProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const recording = snapshot.recordingStatus === "recording";
  return (
    <header className="flex flex-wrap items-center gap-3">
      <nav aria-label={t("dayNavigation")} className="flex items-center gap-1">
        <Button
          aria-label={t("previousDay")}
          disabled={
            navigationDisabled || snapshot.date <= snapshot.earliestDate
          }
          onClick={() => onNavigate(shiftDate(snapshot.date, -1))}
          size="icon"
          variant="ghost"
        >
          <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />
        </Button>
        <h1 className="text-lg font-semibold text-balance">
          {snapshot.date === snapshot.today
            ? t("today")
            : format.dateTime(calendarDate(snapshot.date), {
                dateStyle: "full",
              })}
        </h1>
        <Button
          aria-label={t("nextDay")}
          disabled={navigationDisabled || snapshot.date >= snapshot.latestDate}
          onClick={() => onNavigate(shiftDate(snapshot.date, 1))}
          size="icon"
          variant="ghost"
        >
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" />
        </Button>
        {snapshot.date === snapshot.today ? null : (
          <Button
            disabled={navigationDisabled}
            onClick={() => onNavigate(snapshot.today)}
            variant="ghost"
          >
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
    <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
      {snapshot.recordingStatus === "recording" ? (
        <span
          data-activity-recording
          className="bg-destructive size-1.5 rounded-full"
        />
      ) : null}
      {status}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              aria-label={t("encrypted")}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <LockKeyholeIcon aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPopup className="w-72" side="bottom" align="start">
          <PopoverTitle>{t("encrypted")}</PopoverTitle>
          <PopoverDescription>{t("batchPrivacy")}</PopoverDescription>
        </PopoverPopup>
      </Popover>
    </span>
  );
};

type DayContentProps = {
  header: React.ReactNode;
  preferences: ActivityCalendarPreferences;
  onPreferencesChange: (preferences: ActivityCalendarPreferences) => void;
  onCommand: RunCommand;
  snapshot: ActivityDaySnapshot;
  reviewVisible: boolean;
  onReviewStatusChange: (status: ActivityReviewStatus) => void;
};

const DayContent = ({
  header,
  preferences,
  onPreferencesChange,
  onCommand,
  snapshot,
  reviewVisible,
  onReviewStatusChange,
}: DayContentProps) => {
  const t = useTranslations("activity");
  if (snapshot.unreadable && !reviewVisible) {
    return (
      <>
        {header}
        <p className="text-muted-foreground text-sm">{t("unreadableDay")}</p>
      </>
    );
  }
  if (snapshot.segments.length === 0 && !reviewVisible) {
    return (
      <>
        {header}
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      </>
    );
  }
  return (
    <ActivityDayCalendar
      key={snapshot.date}
      onReviewStatusChange={onReviewStatusChange}
      header={header}
      snapshot={snapshot}
      preferences={preferences}
      onPreferencesChange={onPreferencesChange}
      onCopy={(text, onSettled) =>
        onCommand(
          "activity_copy_text",
          { text },
          () => onSettled(true),
          () => onSettled(false),
        )
      }
    />
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

type AppTotalsProps = {
  sampleDuration?: { identifier: string; durationMs: number };
  sourceAppVisuals: readonly ClipboardSourceAppVisual[];
  segments: readonly TimedSegment[];
};

const AppTotals = ({
  sampleDuration,
  segments,
  sourceAppVisuals,
}: AppTotalsProps) => {
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
            <ActivitySourceIcon
              appIdentifier={app.identifier}
              sourceAppVisuals={sourceAppVisuals}
            />
            <bdi className="min-w-0 flex-1 truncate text-sm">{app.name}</bdi>
            <span className="text-muted-foreground text-sm tabular-nums">
              {sampleDuration?.identifier === app.identifier ? (
                <span className="inline-grid">
                  <span
                    data-activity-preview-duration-before=""
                    className="col-start-1 row-start-1"
                  >
                    <Duration durationMs={sampleDuration.durationMs} />
                  </span>
                  <span
                    data-activity-preview-duration-after=""
                    className="col-start-1 row-start-1"
                  >
                    <Duration durationMs={app.durationMs} />
                  </span>
                </span>
              ) : (
                <Duration durationMs={app.durationMs} />
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
};

const useActivityDay = (
  date: string | null,
  onReadError: (message: string) => void,
) => {
  const t = useTranslations("activity");
  const [view, setView] = useState<ActivityView>({ type: "loading" });
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
            setView((previousView) =>
              previousView.type === "ready" ? previousView : { type: "failed" },
            );
            onReadError(errorRead);
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
          setView((previousView) =>
            previousView.type === "ready" ? previousView : { type: "failed" },
          );
          onReadError(errorRead);
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
  }, [date, errorRead, onReadError]);

  return view;
};

const ActivityApp = () => {
  const t = useTranslations("activity");
  const [date, setDate] = useState<string | null>(null);
  const [errorMessage, setError] = useState<string | null>(null);
  const [reviewStatus, setReviewStatus] =
    useState<ActivityReviewStatus>("editing");
  const view = useActivityDay(date, setError);
  const [preferences, setPreferences] = useState<ActivityCalendarPreferences>({
    granularity: 30,
    narrativeDeclines: 0,
  });
  const errorRead = t("errorRead");

  const runCommand: RunCommand = (command, args, onSuccess, onFailure) => {
    setError(null);
    invoke(command, args ?? {})
      .then(() => {
        onSuccess?.();
        return undefined;
      })
      .catch(() => {
        onFailure?.();
        reportActivityError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        setError(
          command === "activity_copy_text" ? t("errorCopy") : t("errorUpdate"),
        );
      });
  };
  const openSettings = () => runCommand("activity_open_settings");

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
  const reviewVisible =
    reviewStatus !== "editing" || snapshot.pendingBatch !== null;
  if (snapshot.persistence === "initializing" && !reviewVisible) {
    // The store announces itself with a change event once it is open.
    return <main className="bg-background min-h-dvh" />;
  }
  if (snapshot.persistence === "deletionOnly" && !reviewVisible) {
    return (
      <ActivityShell>
        <DeletionOnlyNotice
          keyStatus={snapshot.deletionStatus}
          onOpenSettings={openSettings}
        />
        {errorMessage ? <ErrorLine message={errorMessage} /> : null}
      </ActivityShell>
    );
  }
  if (
    snapshot.recordingStatus === "off" &&
    !reviewVisible &&
    snapshot.deletionStatus !== "pending"
  ) {
    return (
      <ActivityShell>
        <ActivityWelcome
          onCommand={runCommand}
          snapshot={snapshot}
          onStart={() =>
            runCommand("activity_set_recording_status", {
              status: "recording",
            })
          }
        />
        {errorMessage ? <ErrorLine message={errorMessage} /> : null}
      </ActivityShell>
    );
  }

  return (
    <ActivityShell>
      {errorMessage ? <ErrorLine message={errorMessage} /> : null}
      {snapshot.deletionStatus === "incompatible" ? (
        <ErrorLine message={t("incompatibleActivity")} />
      ) : null}
      <DayContent
        preferences={preferences}
        onPreferencesChange={setPreferences}
        reviewVisible={reviewVisible}
        onReviewStatusChange={setReviewStatus}
        header={
          <DayHeader
            navigationDisabled={reviewStatus === "submitting"}
            onNavigate={(next) =>
              setDate(next === snapshot.today ? null : next)
            }
            onToggleRecording={() =>
              runCommand("activity_set_recording_status", {
                status:
                  snapshot.recordingStatus === "recording"
                    ? "paused"
                    : "recording",
              })
            }
            snapshot={snapshot}
          />
        }
        onCommand={runCommand}
        snapshot={snapshot}
      />
      <div>
        <OpenSettingsButton onOpen={openSettings} />
      </div>
    </ActivityShell>
  );
};

export default ActivityApp;
