import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
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
  TextIcon,
  FileTextIcon,
  Trash2Icon,
  XIcon,
} from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
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
  documentName,
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
  ActivityDetailsAccess,
  ActivityRetention,
} from "./activity-types";
import { ProposedBlockAction } from "./ProposedBlockAction";
import { TimeEntryDialog } from "./TimeEntryDialog";

type ActivityView =
  | { type: "loading" }
  | { type: "failed" }
  | { snapshot: ActivityDaySnapshot; type: "ready" };

type ActivityDialog =
  | { type: "closed" }
  | { date: string; type: "deleteDay" }
  | { type: "deleteAll" }
  | { days: number; type: "deleteOtherAccountHistory" }
  | { app: ActivityAppExclusion; type: "excludeApp" };

type ActivityCommand =
  | "activity_copy_text"
  | "activity_delete_all"
  | "activity_delete_day"
  | "activity_delete_other_account_history"
  | "activity_set_browser_title_capture"
  | "activity_set_capture_details"
  | "activity_set_app_detail_capture"
  | "activity_open_accessibility_settings"
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
      <CaptureDetailsControl onCommand={onCommand} snapshot={snapshot} />
      <div>
        <Button onClick={onStart}>{t("welcomeStart")}</Button>
      </div>
    </section>
  );
};

type DetailsAccessNoticeProps = {
  access: ActivityDetailsAccess;
  onCommand: RunCommand;
};

const DetailsAccessNotice = ({
  access,
  onCommand,
}: DetailsAccessNoticeProps) => {
  const t = useTranslations("activity");
  switch (access) {
    case "disabled":
    case "ready":
      return null;
    case "accessibilityRequired":
      return (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <p>{t("accessibilityRequired")}</p>
          <Button
            onClick={() => onCommand("activity_open_accessibility_settings")}
            size="sm"
            variant="ghost"
          >
            {t("openAccessibilitySettings")}
          </Button>
        </div>
      );
    case "unavailable":
      return (
        <p className="text-muted-foreground text-xs">
          {t("detailsUnavailable")}
        </p>
      );
    default:
      access satisfies never;
      return panic("Unhandled activity details access");
  }
};

type CaptureDetailsControlProps = {
  onCommand: RunCommand;
  snapshot: ActivityDaySnapshot;
};

const CaptureDetailsControl = ({
  onCommand,
  snapshot,
}: CaptureDetailsControlProps) => {
  const t = useTranslations("activity");
  return (
    <div className="flex flex-col gap-2">
      <Label className="items-start gap-2" htmlFor="activity-capture-details">
        <Checkbox
          checked={snapshot.captureDetails}
          id="activity-capture-details"
          onCheckedChange={(enabled) =>
            onCommand("activity_set_capture_details", { enabled })
          }
        />
        <span>{t("captureDetails")}</span>
      </Label>
      <p className="text-muted-foreground text-xs">
        {t("captureDetailsDescription")}
      </p>
      <DetailsAccessNotice
        access={snapshot.detailsAccess}
        onCommand={onCommand}
      />
      {snapshot.browserApps.length > 0 ? (
        <div className="flex flex-col gap-2">
          {snapshot.browserApps.map((browser) => (
            <div className="flex flex-col gap-1" key={browser.identifier}>
              <Label
                className="items-start gap-2"
                htmlFor={`activity-browser-title-${browser.identifier}`}
              >
                <Checkbox
                  id={`activity-browser-title-${browser.identifier}`}
                  checked={snapshot.browserTitleApps.some(
                    ({ identifier }) => identifier === browser.identifier,
                  )}
                  disabled={
                    !snapshot.captureDetails ||
                    snapshot.appNameOnlyApps.some(
                      ({ identifier }) => identifier === browser.identifier,
                    )
                  }
                  onCheckedChange={(enabled) =>
                    onCommand("activity_set_browser_title_capture", {
                      identifier: browser.identifier,
                      name: browser.name,
                      enabled,
                    })
                  }
                />
                <span>
                  {t("captureBrowserTitles", { browser: browser.name })}
                </span>
              </Label>
              {snapshot.appNameOnlyApps.some(
                ({ identifier }) => identifier === browser.identifier,
              ) ? (
                <p className="text-muted-foreground text-xs">
                  {t("browserAppNameOnly")}
                </p>
              ) : null}
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            {t("browserPrivacyNote")}
          </p>
        </div>
      ) : null}
    </div>
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
        onCommand={onCommand}
        key={snapshot.date}
        snapshot={snapshot}
        segments={segments}
      />
      <AppTotals
        onCommand={onCommand}
        onExclude={onExclude}
        segments={segments}
        appNameOnlyApps={snapshot.appNameOnlyApps}
      />
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
  onCommand: RunCommand;
  snapshot: ActivityDaySnapshot;
  segments: readonly TimedSegment[];
};

const ProposedBlocks = ({ onCommand, snapshot, segments }: ProposedBlocksProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const timeRange = useTimeRange();
