import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic } from "better-result";
import { useFormatter, useTranslations } from "use-intl";

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
  timedSegments,
} from "./activity-logic";
import type { TimedSegment } from "./activity-logic";
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
import { ActivityDayReview } from "./ActivityDayReview";
import { ActivitySourceIcon } from "./ActivitySourceIcon";

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
        snapshot={snapshot}
        description="collapsed"
      />
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
  description?: "visible" | "collapsed";
};

const CaptureDetailsControl = ({
  description = "visible",
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
      {description === "visible" ? (
        <p className="text-muted-foreground text-xs">
          {t("captureDetailsDescription")}
        </p>
      ) : null}
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
    <header className="flex flex-wrap items-center gap-3">
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
        <h1 className="text-lg font-semibold text-balance">
          {snapshot.date === snapshot.today
            ? t("today")
            : format.dateTime(calendarDate(snapshot.date), {
                dateStyle: "full",
              })}
        </h1>
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
    <span className="text-muted-foreground bg-muted flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
      {snapshot.recordingStatus === "recording" ? (
        <span
          data-activity-recording
          className="bg-destructive size-1.5 rounded-full"
        />
      ) : null}
      <LockKeyholeIcon aria-hidden="true" className="size-3" />
      {status} · {t("encrypted")}
    </span>
  );
};

type DayContentProps = {
  header: React.ReactNode;
  onCommand: RunCommand;
  snapshot: ActivityDaySnapshot;
};

const DayContent = ({ header, onCommand, snapshot }: DayContentProps) => {
  const t = useTranslations("activity");
  if (snapshot.unreadable) {
    return (
      <>
        {header}
        <p className="text-muted-foreground text-sm">{t("unreadableDay")}</p>
      </>
    );
  }
  if (snapshot.segments.length === 0) {
    return (
      <>
        {header}
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      </>
    );
  }
  return (
    <ActivityDayReview
      key={snapshot.date}
      header={header}
      snapshot={snapshot}
      onCopy={(text, onSuccess) =>
        onCommand("activity_copy_text", { text }, onSuccess)
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
  sourceAppVisuals: readonly ClipboardSourceAppVisual[];
  controls?: {
    onCommand: RunCommand;
    appNameOnlyApps: readonly ActivityAppExclusion[];
    onExclude: (app: ActivityAppExclusion) => void;
  };
  segments: readonly TimedSegment[];
};

const AppTotals = ({
  controls,
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
              <Duration durationMs={app.durationMs} />
            </span>
            {controls ? (
              <>
                <AppDetailCaptureButton
                  app={app}
                  onCommand={controls.onCommand}
                  mode={appDetailCaptureMode({
                    appIdentifier: app.identifier,
                    appNameOnlyApps: controls.appNameOnlyApps,
                  })}
                />
                <Button
                  aria-label={t("excludeApp", { name: app.name })}
                  onClick={() =>
                    controls.onExclude({
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
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
};

type AppDetailCaptureMode = "appNameOnly" | "includeDetails";
type AppDetailCaptureModeOptions = {
  appIdentifier: string;
  appNameOnlyApps: readonly ActivityAppExclusion[];
};

const appDetailCaptureMode = ({
  appIdentifier,
  appNameOnlyApps,
}: AppDetailCaptureModeOptions): AppDetailCaptureMode => {
  if (appNameOnlyApps.some(({ identifier }) => identifier === appIdentifier)) {
    return "appNameOnly";
  }
  return "includeDetails";
};

type AppDetailCaptureButtonProps = {
  app: ActivityAppExclusion;
  mode: AppDetailCaptureMode;
  onCommand: RunCommand;
};

const AppDetailCaptureButton = ({
  app,
  mode,
  onCommand,
}: AppDetailCaptureButtonProps) => {
  const t = useTranslations("activity");
  switch (mode) {
    case "appNameOnly":
      return (
        <Button
          size="icon"
          aria-label={t("recordAppDetails", { name: app.name })}
          title={t("recordAppDetails", { name: app.name })}
          onClick={() =>
            onCommand("activity_set_app_detail_capture", {
              identifier: app.identifier,
              name: app.name,
              mode: "includeDetails",
            })
          }
          variant="ghost"
        >
          <FileTextIcon aria-hidden="true" />
        </Button>
      );
    case "includeDetails":
      return (
        <Button
          size="icon"
          aria-label={t("recordAppNameOnly", { name: app.name })}
          title={t("recordAppNameOnly", { name: app.name })}
          onClick={() =>
            onCommand("activity_set_app_detail_capture", {
              identifier: app.identifier,
              name: app.name,
              mode: "appNameOnly",
            })
          }
          variant="ghost"
        >
          <TextIcon aria-hidden="true" />
        </Button>
      );
    default:
      mode satisfies never;
      return panic("Unhandled activity app detail capture");
  }
};

type OtherAccountHistoryProps = {
  days: number;
  onDelete: () => void;
};

const OtherAccountHistory = ({ days, onDelete }: OtherAccountHistoryProps) => {
  const t = useTranslations("activity");
  if (days === 0) {
    return null;
  }
  return (
    <div className="text-muted-foreground flex items-center justify-between gap-3 text-xs">
      <p>{t("otherAccountHistory", { days })}</p>
      <Button onClick={onDelete} size="sm" variant="ghost">
        {t("deleteOtherAccountHistory")}
      </Button>
    </div>
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
      <CaptureDetailsControl onCommand={onCommand} snapshot={snapshot} />
      {snapshot.appNameOnlyApps.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm">{t("appNameOnlyApps")}</span>
          <ul className="flex flex-col gap-1">
            {snapshot.appNameOnlyApps.map((app) => (
              <li
                className="flex items-center justify-between gap-2 text-sm"
                key={app.identifier}
              >
                <span className="truncate">{app.name}</span>
                <AppDetailCaptureButton
                  app={app}
                  onCommand={onCommand}
                  mode={appDetailCaptureMode({
                    appIdentifier: app.identifier,
                    appNameOnlyApps: snapshot.appNameOnlyApps,
                  })}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
    case "deleteOtherAccountHistory":
      return (
        <ConfirmDialog
          description={t("deleteOtherAccountHistoryConfirmation", {
            days: dialog.days,
          })}
          onClose={onClose}
          onConfirm={() =>
            onCommand("activity_delete_other_account_history", {}, onClose)
          }
          title={t("deleteOtherAccountHistory")}
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
  const otherAccountHistory = (
    <OtherAccountHistory
      days={snapshot.otherAccountHistoryDays}
      onDelete={() =>
        setDialog({
          days: snapshot.otherAccountHistoryDays,
          type: "deleteOtherAccountHistory",
        })
      }
    />
  );
  const dialogView = (
    <ActivityDialogView
      dialog={dialog}
      onClose={() => setDialog({ type: "closed" })}
      onCommand={runCommand}
    />
  );
  if (snapshot.persistence === "deletionOnly") {
    return (
      <ActivityShell>
        <DeletionOnlyNotice onDelete={() => setDialog({ type: "deleteAll" })} />
        {otherAccountHistory}
        {error ? <ErrorLine message={error} /> : null}
        {dialogView}
      </ActivityShell>
    );
  }
  if (snapshot.recordingStatus === "off") {
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
        {otherAccountHistory}
        {error ? <ErrorLine message={error} /> : null}
        {dialogView}
      </ActivityShell>
    );
  }

  return (
    <ActivityShell>
      {error ? <ErrorLine message={error} /> : null}
      <DayContent
        header={
          <DayHeader
            onNavigate={setDate}
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
      <details>
        <summary className="text-muted-foreground cursor-pointer text-sm">
          {t("settings")}
        </summary>
        <AppTotals
          controls={{
            onCommand: runCommand,
            onExclude: (app) => setDialog({ app, type: "excludeApp" }),
            appNameOnlyApps: snapshot.appNameOnlyApps,
          }}
          segments={timedSegments(snapshot.segments)}
          sourceAppVisuals={snapshot.sourceAppVisuals}
        />
        <ActivitySettings
          onCommand={runCommand}
          onDeleteAll={() => setDialog({ type: "deleteAll" })}
          onDeleteDay={() =>
            setDialog({ date: snapshot.date, type: "deleteDay" })
          }
          snapshot={snapshot}
        />
      </details>
      {otherAccountHistory}
      {dialogView}
    </ActivityShell>
  );
};

export default ActivityApp;
