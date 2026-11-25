import { useState, useSyncExternalStore } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type {
  RelaunchBlocker,
  UpdaterSnapshot,
  UpdaterState,
  UpdaterStep,
} from "@stll/api-contract/desktop-rpc";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { SettingsRow } from "@stll/ui/settings";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { StellaAppIcon } from "../shared/StellaAppIcon";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import type { DesktopErrorReport } from "../telemetry/desktop-telemetry";

/** The event the native updater announces each state change with. */
export const UPDATER_STATE_EVENT = "updater-state";

/** Reports a failure of the updater's view to the desktop's telemetry. */
type ReportUpdaterFailure = (code: DesktopErrorReport["code"]) => void;

const reportUpdaterFailure: ReportUpdaterFailure = (code) => {
  reportDesktopError({
    code,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};

/**
 * The native updater's state as this window last heard it. The updater owns
 * it: the startup check, the background schedule, a handoff, the tray and
 * Settings all move it, so a download started anywhere shows here. Answers
 * and events can arrive out of order; the higher revision wins.
 */
const createUpdaterStore = (reportFailure: ReportUpdaterFailure) => {
  let latest: UpdaterSnapshot | null = null;
  let stopListening: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const accept = (value: unknown) => {
    if (!isUpdaterSnapshot(value)) {
      reportFailure(DESKTOP_TELEMETRY_ERROR_CODES.invalidResponse);
      return;
    }
    if (latest !== null && value.revision <= latest.revision) {
      return;
    }
    latest = value;
    for (const listener of listeners) {
      listener();
    }
  };

  /** Runs a native updater command and keeps its answer. */
  const command = async (call: () => Promise<unknown>) => {
    const answer = await Result.tryPromise(call);
    if (Result.isOk(answer)) {
      accept(answer.value);
    } else {
      reportFailure(DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed);
    }
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    stopListening ??= subscribeDesktopEvent<unknown>({
      event: UPDATER_STATE_EVENT,
      handler: (event) => {
        accept(event.payload);
      },
      onError: () => {
        reportFailure(DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed);
      },
      // Read once the event is live, so no change falls between the two.
      onSubscribed: () => {
        void command(async () => invoke<unknown>("updater_state"));
      },
    });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && stopListening !== null) {
        stopListening();
        stopListening = null;
      }
    };
  };

  return { command, getSnapshot: () => latest, subscribe };
};

/**
 * Settings' view of the native updater. "Check for updates", on About or in
 * the tray, asks whether a newer version exists without installing it; an
 * update it finds is installed only when the user asks, through the same
 * check the background schedule runs, and only once nothing on this computer
 * holds a relaunch back. Both answer with what is already under way when a
 * check or install is running.
 */
export const useUpdateCheck = ({
  reportFailure = reportUpdaterFailure,
}: {
  /** Where failures go; the desktop's telemetry unless a caller says. */
  reportFailure?: ReportUpdaterFailure;
} = {}) => {
  const [store] = useState(() => createUpdaterStore(reportFailure));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const run = async () => {
    await store.command(async () => invoke<unknown>("check_for_updates"));
  };

  const install = async () => {
    // On success the app quits to relaunch, so this may never resolve.
    await store.command(async () => invoke<unknown>("install_update"));
  };

  /** Null until the native state arrives. */
  const state: UpdaterState | null = snapshot?.state ?? null;
  return { install, run, state };
};

export type UpdateCheck = ReturnType<typeof useUpdateCheck>;

/**
 * The About page's version row, with the updater's one button and its state.
 * The button checks until an update is found, then installs it; while the
 * update downloads, installs or waits for this computer, it stays in place
 * and says why it cannot be pressed.
 */
export const AppVersionRow = ({
  onEmailSupport,
  supportEmail,
  updateCheck: { install, run, state },
  versionLabel,
}: {
  onEmailSupport: () => void;
  supportEmail: string;
  updateCheck: UpdateCheck;
  /** Null while the version is still loading. */
  versionLabel: string | null;
}) => {
  const t = useTranslations("settings");
  const tTray = useTranslations("tray");

  const action = updaterAction(state);
  // Why the install button cannot be pressed now, while it cannot.
  let blockedReason: string | undefined;
  if (action.kind === "waiting") {
    blockedReason = t(DEFERRED_MESSAGES[action.until], {
      version: action.version,
    });
  } else if (action.kind === "installing") {
    blockedReason = t("updates.installInProgress");
  }
  return (
    <SettingsRow
      description={versionLabel ?? <VersionPlaceholder />}
      footer={
        state === null ||
        state.status === "idle" ||
        state.status === "checking" ? null : (
          <div aria-live="polite" className="flex flex-col gap-1 text-sm">
            <UpdaterOutcome state={state} />
            <p className="text-muted-foreground">
              {t.rich("updates.support", {
                address: supportEmail,
                email: (chunks) => (
                  <Button onClick={onEmailSupport} size="inline" variant="link">
                    <BidiText as="span">{chunks}</BidiText>
                  </Button>
                ),
              })}
            </p>
          </div>
        )
      }
      id="about-app"
      media={<StellaAppIcon className="size-8 rounded-lg" />}
      title={t("stellaDesktop")}
    >
      {action.kind === "check" ? (
        <Button
          // A check in flight shows as loading, which already blocks a
          // second one.
          loading={action.checking}
          onClick={() => {
            void run();
          }}
          variant="outline"
        >
          {tTray("checkForUpdates")}
        </Button>
      ) : (
        <Button
          disabled={action.kind !== "install"}
          disabledReason={blockedReason}
          loading={action.kind === "installing"}
          onClick={() => {
            void install();
          }}
        >
          {t("updates.install")}
        </Button>
      )}
    </SettingsRow>
  );
};

/** What the row's one button does in each updater state. */
type UpdaterAction =
  | { kind: "check"; checking: boolean }
  | { kind: "install" }
  | { kind: "installing" }
  | { kind: "waiting"; until: RelaunchBlocker; version: string };

const updaterAction = (state: UpdaterState | null): UpdaterAction => {
  if (state === null) {
    return { kind: "check", checking: false };
  }
  switch (state.status) {
    case "idle":
    case "up_to_date":
    case "failed":
    case "managed":
      return { kind: "check", checking: false };
    case "checking":
      return { kind: "check", checking: true };
    case "available":
      return { kind: "install" };
    case "downloading":
    case "installing":
      return { kind: "installing" };
    case "deferred":
      return { kind: "waiting", until: state.until, version: state.version };
    default:
      state satisfies never;
      return panic("Unknown updater state");
  }
};

/** What an update that waits for this computer says it waits for. */
const DEFERRED_MESSAGES = {
  agent_runs: "updates.deferredAgents",
  edit_sessions: "updates.deferredEdits",
} as const satisfies Record<RelaunchBlocker, string>;

/** Holds the version line's height while the version loads, so the row
 *  does not jump when it arrives. */
const VersionPlaceholder = () => (
  <span aria-hidden="true" className="invisible">
    0.0.0
  </span>
);

const UpdaterOutcome = ({
  state,
}: {
  state: Exclude<UpdaterState, { status: "idle" } | { status: "checking" }>;
}) => {
  const t = useTranslations("settings");
  const tTray = useTranslations("tray");
  switch (state.status) {
    case "up_to_date":
      return <p>{t("updates.upToDate")}</p>;
    case "available":
      return <p>{t("updates.available", { version: state.version })}</p>;
    case "downloading": {
      const percent = downloadedPercent(state);
      return (
        <div className="flex items-start gap-2">
          <Loader className="mt-0.5" size="sm" variant="decorative" />
          <div className="flex flex-col gap-0.5">
            <p>{t("updates.downloading", { version: state.version })}</p>
            {/* Progress updates several times a second; the line above is
                what gets announced. */}
            {percent === null ? null : (
              <p aria-live="off" className="text-muted-foreground tabular-nums">
                {t("updates.downloadProgress", { percent })}
              </p>
            )}
          </div>
        </div>
      );
    }
    case "installing":
      return <p>{t("updates.installing", { version: state.version })}</p>;
    case "deferred":
      return (
        <p>{t(DEFERRED_MESSAGES[state.until], { version: state.version })}</p>
      );
    case "managed":
      return <p>{tTray("updatesManaged")}</p>;
    case "failed":
      return (
        <p className="text-destructive-foreground" role="alert">
          {state.during === "check"
            ? t("updates.checkFailed")
            : t("updates.installFailed")}
        </p>
      );
    default:
      state satisfies never;
      return panic("Unknown updater state");
  }
};

const PERCENT = 100;

/** How much of the package has arrived, once the server named its size. */
const downloadedPercent = ({
  receivedBytes,
  totalBytes,
}: Extract<UpdaterState, { status: "downloading" }>) =>
  totalBytes === null || totalBytes <= 0
    ? null
    : Math.min(PERCENT, Math.floor((receivedBytes / totalBytes) * PERCENT));

type UpdaterStatus = UpdaterState["status"];

// What each status carries, read off the generated contract: a status added,
// removed or reshaped natively fails to compile here instead of reaching
// Settings as something it cannot show.
type StatePayload<Status extends UpdaterStatus> =
  Extract<UpdaterState, { status: Status }> extends { receivedBytes: number }
    ? "download"
    : Extract<UpdaterState, { status: Status }> extends { during: UpdaterStep }
      ? "during"
      : Extract<UpdaterState, { status: Status }> extends {
            until: RelaunchBlocker;
          }
        ? "deferred"
        : Extract<UpdaterState, { status: Status }> extends { version: string }
          ? "version"
          : "none";

const STATE_PAYLOADS = {
  idle: "none",
  checking: "none",
  up_to_date: "none",
  available: "version",
  downloading: "download",
  installing: "version",
  deferred: "deferred",
  failed: "during",
  managed: "none",
} as const satisfies { [Status in UpdaterStatus]: StatePayload<Status> };

const UPDATER_STEPS = {
  check: true,
  install: true,
} as const satisfies Record<UpdaterStep, true>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUpdaterStatus = (status: unknown): status is UpdaterStatus =>
  typeof status === "string" && Object.hasOwn(STATE_PAYLOADS, status);

const isUpdaterState = (value: unknown): value is UpdaterState => {
  if (!isRecord(value) || !isUpdaterStatus(value["status"])) {
    return false;
  }
  const payload: (typeof STATE_PAYLOADS)[UpdaterStatus] =
    STATE_PAYLOADS[value["status"]];
  switch (payload) {
    case "none":
      return true;
    case "version":
      return typeof value["version"] === "string";
    case "download":
      return (
        typeof value["version"] === "string" &&
        typeof value["receivedBytes"] === "number" &&
        (value["totalBytes"] === null ||
          typeof value["totalBytes"] === "number")
      );
    case "deferred":
      return (
        typeof value["version"] === "string" &&
        typeof value["until"] === "string" &&
        Object.hasOwn(DEFERRED_MESSAGES, value["until"])
      );
    case "during":
      return (
        typeof value["during"] === "string" &&
        Object.hasOwn(UPDATER_STEPS, value["during"])
      );
    default:
      payload satisfies never;
      return panic("Unknown updater state payload");
  }
};

/** What `updater_state`, `check_for_updates`, `install_update` and the
 *  updater's event carry. */
const isUpdaterSnapshot = (value: unknown): value is UpdaterSnapshot =>
  isRecord(value) &&
  typeof value["revision"] === "number" &&
  isUpdaterState(value["state"]);
