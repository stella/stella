import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";

import {
  ACTIVITY_CHANGED_EVENT,
  ACTIVITY_DETAILS_ACCESS,
  ACTIVITY_RECORDING_STATUSES,
} from "../activity/activity-types";
import type { ActivityDetailsAccess } from "../activity/activity-types";
import { subscribeDesktopEvent } from "../shared/desktop-events";
import { reportOnboardingFailure } from "./onboarding-telemetry";

/** What setup reads of Activity (`activity_get_setup`): whether recording
 *  has started and the choices setup offers, the ones Settings stores. */
export type ActivitySetupSnapshot = {
  captureDetails: boolean;
  detailsAccess: ActivityDetailsAccess;
  detectCalls: boolean;
  recordingStatus: (typeof ACTIVITY_RECORDING_STATUSES)[number];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOneOf = (values: readonly string[], value: unknown) =>
  values.some((candidate) => candidate === value);

const isActivitySetupSnapshot = (
  value: unknown,
): value is ActivitySetupSnapshot =>
  isRecord(value) &&
  typeof value["captureDetails"] === "boolean" &&
  isOneOf(ACTIVITY_DETAILS_ACCESS, value["detailsAccess"]) &&
  typeof value["detectCalls"] === "boolean" &&
  isOneOf(ACTIVITY_RECORDING_STATUSES, value["recordingStatus"]);

export type ActivitySetupControls = {
  /** `null` until a read lands. */
  snapshot: ActivitySetupSnapshot | null;
  /** The last change did not reach the native side. */
  failed: boolean;
  /** The last read did not land; `snapshot` is still the one before it. */
  unread: boolean;
  reload: () => void;
  /** Starts recording; resolves to whether it started. */
  start: () => Promise<boolean>;
  setCaptureDetails: (enabled: boolean) => Promise<void>;
  setDetectCalls: (enabled: boolean) => Promise<void>;
};

/**
 * Activity as setup sees it, and the changes setup offers. Each change is
 * the command Settings sends, so Settings shows it the moment it lands; the
 * native side announces it, and every window reads again.
 */
export const useActivitySetup = (): ActivitySetupControls => {
  const [snapshot, setSnapshot] = useState<ActivitySetupSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [unread, setUnread] = useState(false);
  // Event reads land in any order; only the most recent may set the state.
  const latest = useRef(0);
  // The read the effect below owns; it is set on mount, before any change
  // can be made, so a missing one is a bug.
  const reread = useRef<(() => Promise<void>) | null>(null);
  const readAgain = async () => {
    const read = reread.current ?? panic("Activity setup read before mount.");
    await read();
  };

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      latest.current += 1;
      const read = latest.current;
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("activity_get_setup"),
      );
      if (disposed || read !== latest.current) {
        return;
      }
      if (Result.isError(result) || !isActivitySetupSnapshot(result.value)) {
        reportOnboardingFailure();
        setUnread(true);
        return;
      }
      setUnread(false);
      setSnapshot(result.value);
    };
    const stopListening = subscribeDesktopEvent({
      event: ACTIVITY_CHANGED_EVENT,
      handler: () => {
        void refresh();
      },
      onError: reportOnboardingFailure,
    });
    reread.current = refresh;
    void refresh();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  /** Runs one native change, then reads the state it left. */
  const run = async (change: () => Promise<unknown>) => {
    const result = await Result.tryPromise(change);
    if (Result.isError(result)) {
      reportOnboardingFailure();
      setFailed(true);
      return false;
    }
    setFailed(false);
    await readAgain();
    return true;
  };

  return {
    failed,
    reload: () => {
      void readAgain();
    },
    setCaptureDetails: async (enabled) => {
      await run(async () =>
        invoke("activity_set_capture_details", { enabled }),
      );
    },
    setDetectCalls: async (enabled) => {
      await run(async () => invoke("activity_set_detect_calls", { enabled }));
    },
    snapshot,
    start: async () =>
      run(async () =>
        invoke("activity_set_recording_status", { status: "recording" }),
      ),
    unread,
  };
};
