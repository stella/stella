import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

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
  EyeOffIcon,
  FileTextIcon,
  ShieldAlertIcon,
  TextIcon,
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
import { Skeleton } from "@stll/ui/skeleton";

import type { DesktopMessages } from "../i18n/index";
import { subscribeDesktopEvent } from "../shared/desktop-events";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { calendarDate, shiftDate } from "./activity-logic";
import { DELETION_ONLY_NOTICE } from "./activity-notices";
import {
  ACTIVITY_CHANGED_EVENT,
  ACTIVITY_RETENTIONS,
  isActivitySettingsSnapshot,
} from "./activity-types";
import type {
  ActivityAppExclusion,
  ActivityDeletionStatus,
  ActivityRetention,
  ActivitySettingsSnapshot,
} from "./activity-types";
import { CaptureDetailsControl } from "./ActivityCaptureDetails";
import type { CaptureDetailsCommand } from "./ActivityCaptureDetails";
import { ActivitySourceIcon } from "./ActivitySourceIcon";
import { useBillingDraftSettings } from "./billing-draft-settings";

type ActivitySettingsView =
  | { type: "loading" }
  | { type: "failed" }
  | { settings: ActivitySettingsSnapshot; type: "ready" };

type ActivityDialog =
  | { type: "closed" }
  | { date: string; type: "deleteDay" }
  | { type: "deleteAll" }
  | { days: number; type: "deleteOtherAccountHistory" }
  | { type: "eraseMissingKeyAll" }
  | { type: "eraseUnrecoverableOtherAccounts" }
  | { type: "eraseUnreadableAll" }
  | { app: ActivityAppExclusion; type: "excludeApp" };

type ActivitySettingsCommand =
  | CaptureDetailsCommand
  | "activity_delete_all"
  | "activity_delete_day"
  | "activity_delete_other_account_history"
  | "activity_exclude_app"
  | "activity_remove_app_exclusion"
  | "activity_set_app_detail_capture"
  | "activity_set_detect_calls"
  | "activity_set_retention";

type RunCommand = (
  command: ActivitySettingsCommand,
  args?: Record<string, unknown>,
  onSuccess?: () => void,
  onFailure?: () => void,
) => void;

const RETENTION_LABEL_KEYS = {
  month: "retentionMonth",
  quarter: "retentionQuarter",
  week: "retentionWeek",
} as const satisfies Record<ActivityRetention, string>;

const BLOCKED_DELETION_NOTICE = {
  available: "pendingActivityProtected",
  pending: "pendingActivityProtected",
  unavailable: "errorRead",
  keyMissing: "pendingActivityProtected",
  unreadable: "unreadableEraseNotice",
  incompatible: "incompatibleActivity",
} as const satisfies Record<
  ActivityDeletionStatus,
  keyof DesktopMessages["activity"]
>;

const DELETION_FAILURES = [
  "incompatible",
  "keyMissing",
  "pendingBatch",
  "unavailable",
  "unreadable",
] as const;

type DeletionFailure = (typeof DELETION_FAILURES)[number];

/** The typed failure a deletion command rejected with, if any. */
function deletionFailure(error: unknown): DeletionFailure | null {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return null;
  }
  const { type } = error;
  return DELETION_FAILURES.find((failure) => failure === type) ?? null;
}

function reportSettingsError(
  operation: (typeof DESKTOP_TELEMETRY_OPERATIONS)[
    "activityRead" | "activitySubscribe" | "activityUpdate"],
  code: (typeof DESKTOP_TELEMETRY_ERROR_CODES)[
    "eventSubscriptionFailed" | "invalidResponse" | "invokeFailed"],
) {
  // Fixed codes only: nothing about what was recorded leaves the window.
  reportDesktopError({
    code,
    operation,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
}

function useActivitySettings(
  date: string | null,
  onReadError: (message: string) => void,
) {
  const t = useTranslations("activity");
  const [view, setView] = useState<ActivitySettingsView>({ type: "loading" });
  const requestId = useRef(0);
  const errorRead = t("errorRead");

  useEffect(() => {
    let disposed = false;
    const fail = (
      code: (typeof DESKTOP_TELEMETRY_ERROR_CODES)[
        "invalidResponse" | "invokeFailed"],
    ) => {
      reportSettingsError(DESKTOP_TELEMETRY_OPERATIONS.activityRead, code);
      setView((previousView) =>
        previousView.type === "ready" ? previousView : { type: "failed" },
      );
      onReadError(errorRead);
    };
    const read = () => {
      requestId.current += 1;
      const current = requestId.current;
      invoke<unknown>("activity_get_settings", { date })
        .then((value) => {
          if (disposed || current !== requestId.current) {
            return undefined;
          }
          if (!isActivitySettingsSnapshot(value)) {
            fail(DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse);
            return undefined;
          }
          setView({ settings: value, type: "ready" });
          return undefined;
        })
        .catch(() => {
          if (disposed || current !== requestId.current) {
            return;
          }
          fail(DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed);
        });
    };
    read();
    const stopListening = subscribeDesktopEvent({
      event: ACTIVITY_CHANGED_EVENT,
      handler: read,
      onError: () => {
        reportSettingsError(
          DESKTOP_TELEMETRY_OPERATIONS.activitySubscribe,
          DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
        );
      },
      onSubscribed: read,
    });
    return () => {
      disposed = true;
      stopListening();
    };
  }, [date, errorRead, onReadError]);

  return view;
}

const ErrorLine = ({ message }: { message: string }) => (
  <p className="text-destructive text-sm" role="alert">
    {message}
  </p>
);

type SettingsSectionProps = {
  onCommand: RunCommand;
  settings: ActivitySettingsSnapshot;
};

const RecordingSettings = ({ onCommand, settings }: SettingsSectionProps) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label className="items-start gap-2" htmlFor="activity-detect-calls">
          <Checkbox
            checked={settings.detectCalls}
            id="activity-detect-calls"
            onCheckedChange={(enabled) =>
              onCommand("activity_set_detect_calls", { enabled })
            }
          />
          <span>{t("detectCalls")}</span>
        </Label>
        <p className="text-muted-foreground text-xs">
          {t("detectCallsDescription")}
        </p>
      </div>
      <BillingDraftConsentSettings />
      <CaptureDetailsControl onCommand={onCommand} settings={settings} />
      {settings.appNameOnlyApps.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm">{t("appNameOnlyApps")}</span>
          <ul className="flex flex-col gap-1">
            {settings.appNameOnlyApps.map((app) => (
              <li
                className="flex items-center justify-between gap-2 text-sm"
                key={app.identifier}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ActivitySourceIcon
                    appIdentifier={app.identifier}
                    sourceAppVisuals={settings.sourceAppVisuals}
                  />
                  <bdi className="truncate">{app.name}</bdi>
                </span>
                <AppDetailCaptureButton
                  app={app}
                  onCommand={onCommand}
                  mode="appNameOnly"
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
          value={settings.retention}
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
        {settings.excludedApps.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("noExclusions")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {settings.excludedApps.map((app) => (
              <li
                className="flex items-center justify-between gap-2 text-sm"
                key={app.identifier}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ActivitySourceIcon
                    appIdentifier={app.identifier}
                    sourceAppVisuals={settings.sourceAppVisuals}
                  />
                  <bdi className="truncate">{app.name}</bdi>
                </span>
                <Button
                  aria-label={t("removeExclusion", { name: app.name })}
                  onClick={() =>
                    onCommand("activity_remove_app_exclusion", {
                      identifier: app.identifier,
                    })
                  }
                  size="icon"
                  title={t("removeExclusion", { name: app.name })}
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

type DayAppsProps = SettingsSectionProps & {
  deletionDisabled: boolean;
  onDateChange: (date: string) => void;
  onDeleteDay: () => void;
  onExclude: (app: ActivityAppExclusion) => void;
};

/** One day's apps with their exclusion controls, and that day's deletion. */
const DayApps = ({
  deletionDisabled,
  onCommand,
  onDateChange,
  onDeleteDay,
  onExclude,
  settings,
}: DayAppsProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  const days: string[] = [];
  for (
    let day = settings.latestDate;
    day >= settings.earliestDate;
    day = shiftDate(day, -1)
  ) {
    days.push(day);
  }
  if (!days.includes(settings.date)) {
    days.push(settings.date);
  }
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold" id="activity-day-apps-label">
        {t("byApp")}
      </h3>
      <Select
        onValueChange={(day) => {
          if (typeof day === "string") {
            onDateChange(day);
          }
        }}
        value={settings.date}
      >
        <SelectTrigger aria-label={t("dayNavigation")} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {days.map((day) => (
            <SelectItem key={day} value={day}>
              {day === settings.today
                ? t("today")
                : format.dateTime(calendarDate(day), { dateStyle: "long" })}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {settings.apps.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t("empty")}</p>
      ) : (
        <ul
          aria-labelledby="activity-day-apps-label"
          className="flex flex-col divide-y rounded-xl border"
        >
          {settings.apps.map((app) => (
            <li
              className="flex items-center gap-3 px-4 py-2"
              key={app.identifier}
            >
              <ActivitySourceIcon
                appIdentifier={app.identifier}
                sourceAppVisuals={settings.sourceAppVisuals}
              />
              <bdi className="min-w-0 flex-1 truncate text-sm">{app.name}</bdi>
              <AppDetailCaptureButton
                app={app}
                onCommand={onCommand}
                mode={
                  settings.appNameOnlyApps.some(
                    ({ identifier }) => identifier === app.identifier,
                  )
                    ? "appNameOnly"
                    : "includeDetails"
                }
              />
              <Button
                disabled={deletionDisabled}
                aria-label={t("excludeApp", { name: app.name })}
                onClick={() => onExclude(app)}
                size="icon"
                title={t("excludeApp", { name: app.name })}
                variant="ghost"
              >
                <EyeOffIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          disabled={deletionDisabled}
          onClick={onDeleteDay}
          variant="outline"
        >
          <Trash2Icon aria-hidden="true" />
          {t("deleteDay")}
        </Button>
      </div>
    </section>
  );
};

type AppDetailCaptureMode = "appNameOnly" | "includeDetails";

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

type HistoryDeletionProps = {
  deletionDisabled: boolean;
  onDeleteAll: () => void;
  otherAccountHistory: ReactNode;
  settings: ActivitySettingsSnapshot;
};

const HistoryDeletion = ({
  deletionDisabled,
  onDeleteAll,
  otherAccountHistory,
  settings,
}: HistoryDeletionProps) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-3">
      {deletionDisabled && settings.deletionStatus !== "incompatible" ? (
        <p className="text-muted-foreground text-xs">
          {t(BLOCKED_DELETION_NOTICE[settings.deletionStatus])}
        </p>
      ) : null}
      <div>
        <Button
          disabled={
            deletionDisabled && settings.deletionStatus !== "unreadable"
          }
          onClick={onDeleteAll}
          variant="destructive"
        >
          <Trash2Icon aria-hidden="true" />
          {settings.deletionStatus === "unreadable"
            ? t("unreadableEraseAction")
            : t("deleteAll")}
        </Button>
      </div>
      {otherAccountHistory}
    </section>
  );
};

type OtherAccountHistoryProps = {
  days: number;
  onDelete: () => void;
  deletionDisabled: boolean;
};

const OtherAccountHistory = ({
  days,
  onDelete,
  deletionDisabled,
}: OtherAccountHistoryProps) => {
  const t = useTranslations("activity");
  if (days === 0) {
    return null;
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground text-xs">
        {t("otherAccountHistory", { days })}
      </p>
      <Button disabled={deletionDisabled} onClick={onDelete} variant="outline">
        {t("deleteOtherAccountHistory")}
      </Button>
    </div>
  );
};

type DeletionOnlyNoticeProps = {
  onErase: () => void;
  keyStatus: ActivityDeletionStatus;
};

const DeletionOnlyNotice = ({
  onErase,
  keyStatus,
}: DeletionOnlyNoticeProps) => {
  const t = useTranslations("activity");
  return (
    <section className="flex flex-col gap-4 rounded-2xl border p-4">
      <div className="flex gap-3">
        <ShieldAlertIcon
          aria-hidden="true"
          className="text-destructive mt-0.5 size-4 shrink-0"
        />
        <p className="text-sm leading-relaxed">
          {t(DELETION_ONLY_NOTICE[keyStatus])}
        </p>
      </div>
      {keyStatus === "keyMissing" || keyStatus === "unreadable" ? (
        <div>
          <Button onClick={onErase} variant="destructive">
            {keyStatus === "unreadable"
              ? t("unreadableEraseAction")
              : t("deleteAll")}
          </Button>
        </div>
      ) : null}
    </section>
  );
};

type ActivityDialogViewProps = {
  deletionStatus: ActivityDeletionStatus;
  dialog: ActivityDialog;
  sourceAppVisuals: ActivitySettingsSnapshot["sourceAppVisuals"];
  onClose: () => void;
  onCommand: RunCommand;
};

const ActivityDialogView = ({
  deletionStatus,
  dialog,
  sourceAppVisuals,
  onClose,
  onCommand,
}: ActivityDialogViewProps) => {
  const t = useTranslations("activity");
  const format = useFormatter();
  if (deletionStatus === "incompatible") {
    return null;
  }
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
          title={
            <span className="flex items-center gap-2">
              <ActivitySourceIcon
                appIdentifier={dialog.app.identifier}
                sourceAppVisuals={sourceAppVisuals}
              />
              {t("excludeApp", { name: dialog.app.name })}
            </span>
          }
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
            onCommand(
              "activity_delete_other_account_history",
              { recovery: "preserve" },
              onClose,
            )
          }
          title={t("deleteOtherAccountHistory")}
        />
      );
    case "eraseMissingKeyAll":
      return (
        <ConfirmDialog
          description={t("missingKeyEraseConfirmation")}
          onClose={onClose}
          onConfirm={() =>
            onCommand(
              "activity_delete_all",
              { recovery: "discardMissingKey" },
              onClose,
            )
          }
          title={t("deleteAll")}
        />
      );
    case "eraseUnreadableAll":
      return (
        <ConfirmDialog
          description={t("unreadableEraseConfirmation")}
          onClose={onClose}
          onConfirm={() =>
            onCommand(
              "activity_delete_all",
              { recovery: "discardUnreadable" },
              onClose,
            )
          }
          title={t("unreadableEraseAction")}
        />
      );
    case "eraseUnrecoverableOtherAccounts":
      return (
        <ConfirmDialog
          description={t("unrecoverableOtherHistoryConfirmation")}
          onClose={onClose}
          onConfirm={() =>
            onCommand(
              "activity_delete_other_account_history",
              { recovery: "discardUnrecoverable" },
              onClose,
            )
          }
          title={t("deleteOtherAccountHistory")}
        />
      );
    case "deleteAll":
      return (
        <ConfirmDialog
          description={t("deleteAllConfirmation")}
          onClose={onClose}
          onConfirm={() =>
            onCommand("activity_delete_all", { recovery: "preserve" }, onClose)
          }
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
  title: ReactNode;
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

/**
 * The Settings window's Activity tab: every activity setting, exclusions,
 * deletion and recovery. It reads `activity_get_settings`, never the day
 * timeline, and reads again on every activity change.
 */
/** Holds the Activity tab's shape while its access or settings load. */
export const ActivitySettingsSkeleton = () => (
  <div aria-busy="true" className="space-y-4">
    <Skeleton className="h-32 rounded-xl" />
    <Skeleton className="h-20 rounded-xl" />
  </div>
);

export const ActivitySettingsPane = () => {
  const t = useTranslations("activity");
  const [date, setDate] = useState<string | null>(null);
  const [errorMessage, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ActivityDialog>({ type: "closed" });
  const view = useActivitySettings(date, setError);

  const runCommand: RunCommand = (command, args, onSuccess, onFailure) => {
    const commandArgs = args ?? {};
    const deletionStatus =
      view.type === "ready" ? view.settings.deletionStatus : "unavailable";
    const confirmedRecoveryErase =
      (command === "activity_delete_all" &&
        (commandArgs["recovery"] === "discardMissingKey" ||
          commandArgs["recovery"] === "discardUnreadable")) ||
      (command === "activity_delete_other_account_history" &&
        commandArgs["recovery"] === "discardUnrecoverable");
    const inactiveRecoveryPreflight =
      command === "activity_delete_other_account_history" &&
      commandArgs["recovery"] === "preserve" &&
      (deletionStatus === "keyMissing" || deletionStatus === "unreadable");
    if (
      deletionStatus !== "available" &&
      !confirmedRecoveryErase &&
      !inactiveRecoveryPreflight &&
      (command === "activity_delete_day" ||
        command === "activity_delete_all" ||
        command === "activity_delete_other_account_history" ||
        (command === "activity_exclude_app" &&
          commandArgs["history"] === "delete"))
    ) {
      setError(t(BLOCKED_DELETION_NOTICE[deletionStatus]));
      onFailure?.();
      return;
    }
    setError(null);
    invoke(command, commandArgs)
      .then(() => {
        onSuccess?.();
        return undefined;
      })
      .catch((error: unknown) => {
        onFailure?.();
        reportSettingsError(
          DESKTOP_TELEMETRY_OPERATIONS.activityUpdate,
          DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        );
        const failure = deletionFailure(error);
        switch (failure) {
          case "incompatible":
            setDialog({ type: "closed" });
            setError(t("incompatibleActivity"));
            return;
          case "keyMissing":
          case "unreadable":
            if (command === "activity_delete_other_account_history") {
              setDialog({ type: "eraseUnrecoverableOtherAccounts" });
              return;
            }
            if (command === "activity_delete_all") {
              setDialog({
                type:
                  failure === "unreadable"
                    ? "eraseUnreadableAll"
                    : "eraseMissingKeyAll",
              });
              return;
            }
            setError(t("errorUpdate"));
            return;
          case "pendingBatch":
            setError(t("pendingActivityProtected"));
            return;
          case "unavailable":
            setError(t("errorRead"));
            return;
          case null:
            setError(t("errorUpdate"));
            return;
          default:
            failure satisfies never;
            panic("Unhandled activity deletion failure");
        }
      });
  };

  switch (view.type) {
    case "loading":
      return <ActivitySettingsSkeleton />;
    case "failed":
      return <ErrorLine message={t("errorRead")} />;
    case "ready":
      break;
    default:
      view satisfies never;
      return panic("Unhandled activity settings view");
  }

  const { settings } = view;
  if (settings.persistence === "initializing") {
    // The store announces itself with a change event once it is open.
    return <ActivitySettingsSkeleton />;
  }
  const deletionDisabled = settings.deletionStatus !== "available";
  const otherAccountHistory = (
    <OtherAccountHistory
      days={settings.otherAccountHistoryDays}
      deletionDisabled={
        deletionDisabled &&
        settings.deletionStatus !== "keyMissing" &&
        settings.deletionStatus !== "unreadable"
      }
      onDelete={() =>
        setDialog({
          days: settings.otherAccountHistoryDays,
          type: "deleteOtherAccountHistory",
        })
      }
    />
  );
  const dialogView = (
    <ActivityDialogView
      deletionStatus={settings.deletionStatus}
      dialog={dialog}
      sourceAppVisuals={settings.sourceAppVisuals}
      onClose={() => setDialog({ type: "closed" })}
      onCommand={runCommand}
    />
  );
  if (settings.persistence === "deletionOnly") {
    return (
      <div className="flex flex-col gap-4">
        <DeletionOnlyNotice
          keyStatus={settings.deletionStatus}
          onErase={() =>
            setDialog({
              type:
                settings.deletionStatus === "unreadable"
                  ? "eraseUnreadableAll"
                  : "eraseMissingKeyAll",
            })
          }
        />
        {otherAccountHistory}
        {errorMessage ? <ErrorLine message={errorMessage} /> : null}
        {dialogView}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {errorMessage ? <ErrorLine message={errorMessage} /> : null}
      {settings.deletionStatus === "incompatible" ? (
        <ErrorLine message={t("incompatibleActivity")} />
      ) : null}
      <RecordingSettings onCommand={runCommand} settings={settings} />
      <DayApps
        deletionDisabled={deletionDisabled}
        onCommand={runCommand}
        onDateChange={(next) => setDate(next === settings.today ? null : next)}
        onDeleteDay={() =>
          setDialog({ date: settings.date, type: "deleteDay" })
        }
        onExclude={(app) => setDialog({ app, type: "excludeApp" })}
        settings={settings}
      />
      <HistoryDeletion
        deletionDisabled={deletionDisabled}
        onDeleteAll={() =>
          setDialog({
            type:
              settings.deletionStatus === "unreadable"
                ? "eraseUnreadableAll"
                : "deleteAll",
          })
        }
        otherAccountHistory={otherAccountHistory}
        settings={settings}
      />
      {dialogView}
    </div>
  );
};

/**
 * Consent to stella AI drafts, kept on the server. Withdrawing stays possible
 * whenever consent exists, even where the firm has drafting off; it applies
 * in this window at once and is sent again until the server confirms it.
 */
const BillingDraftConsentSettings = () => {
  const t = useTranslations("activity");
  const { settings, setConsent } = useBillingDraftSettings(true);
  if (settings.type === "loading" || settings.type === "unavailable") {
    return null;
  }
  if (settings.type === "failed") {
    return (
      <p className="text-muted-foreground text-xs">
        {t("billingDraftsUnavailable")}
      </p>
    );
  }
  const { consent } = settings;
  const withdrawable =
    consent === "granted" || consent === "pending-withdrawal";
  if (!withdrawable && settings.mode === "off") {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm">{t("billingDraftsTitle")}</span>
      <p className="text-muted-foreground text-xs">
        {withdrawable ? t("billingDraftsGranted") : t("billingDraftsRevoked")}
      </p>
      {consent === "pending-withdrawal" ? (
        <p className="text-muted-foreground text-xs" role="status">
          {t("billingDraftsWithdrawPending")}
        </p>
      ) : null}
      {consent === "granted" ? (
        <Button
          className="self-start"
          onClick={() => {
            void setConsent("revoked");
          }}
          variant="outline"
        >
          {t("billingDraftsWithdraw")}
        </Button>
      ) : null}
    </div>
  );
};
