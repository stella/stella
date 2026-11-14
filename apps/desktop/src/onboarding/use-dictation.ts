import { useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { isShortcutKeys } from "../shared/shortcut-keys";
import type { ShortcutKeys } from "../shared/shortcut-keys";
import { reportOnboardingFailure } from "./onboarding-telemetry";

/** The parts of the native dictation snapshot (`dictation.rs`) setup shows. */
type DictationModel =
  | { status: "missing" | "failed" | "ready" }
  | { received: number; status: "downloading"; total: number };

/** The native failures setup has a text for. */
const DICTATION_FAILURES = [
  "accessibility",
  "cloudTranscription",
  "focusChanged",
  "focusUnconfirmed",
  "microphone",
  "modelMissing",
  "shortcutHeld",
  "transcription",
] as const;

type DictationFailure = (typeof DICTATION_FAILURES)[number];

/**
 * The failure as setup can name it. The native side may report one this
 * window has no text for; setup then stays as it is and says nothing.
 */
export const namedDictationFailure = (
  failure: string | null,
): DictationFailure | null =>
  DICTATION_FAILURES.find((named) => named === failure) ?? null;

export type DictationSnapshot = {
  available: boolean;
  enabled: boolean;
  failure: string | null;
  keys: ShortcutKeys;
  model: DictationModel;
  modelBytes: number;
  phase: "idle" | "recording" | "transcribing";
  shortcutTaken: boolean;
};

/** Mirrors the native `CHANGED_EVENT`; payload-free. */
const DICTATION_CHANGED_EVENT = "dictation-changed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isModel = (value: unknown): value is DictationModel => {
  if (!isRecord(value)) {
    return false;
  }
  switch (value["status"]) {
    case "missing":
    case "failed":
    case "ready":
      return true;
    case "downloading":
      return (
        typeof value["received"] === "number" &&
        typeof value["total"] === "number" &&
        value["total"] > 0
      );
    default:
      return false;
  }
};

const isDictationSnapshot = (value: unknown): value is DictationSnapshot =>
  isRecord(value) &&
  typeof value["available"] === "boolean" &&
  typeof value["enabled"] === "boolean" &&
  (value["failure"] === null || typeof value["failure"] === "string") &&
  isShortcutKeys(value["keys"]) &&
  isModel(value["model"]) &&
  typeof value["modelBytes"] === "number" &&
  (value["phase"] === "idle" ||
    value["phase"] === "recording" ||
    value["phase"] === "transcribing") &&
  typeof value["shortcutTaken"] === "boolean";

/** A model that is neither on disk nor on its way. */
const needsDownload = (model: DictationModel) =>
  model.status === "missing" || model.status === "failed";

export type DictationControls = {
  /** `null` until a read lands. */
  snapshot: DictationSnapshot | null;
  /** The last turn-on or download did not reach the native side. */
  failed: boolean;
  /**
   * The last read did not land; `snapshot` is still the one before it, so
   * setup keeps what it showed.
   */
  unread: boolean;
  /** Reads the state again. */
  reload: () => void;
  /** Turns dictation on and starts the speech model download. */
  turnOn: () => Promise<void>;
  download: () => Promise<void>;
};

/**
 * The live dictation state for setup, and the two actions setup offers. The
 * download runs natively, so it goes on after this window moves on or
 * closes; progress arrives through the change event.
 */
export const useDictation = (): DictationControls => {
  const [snapshot, setSnapshot] = useState<DictationSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [unread, setUnread] = useState(false);
  // Event reads and action results land in any order; only the most
  // recently issued one may set the snapshot.
  const latest = useRef(0);
  // The read the effect below owns, for a reload on request.
  const reread = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      latest.current += 1;
      const read = latest.current;
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_snapshot"),
      );
      if (disposed || read !== latest.current) {
        return;
      }
      if (Result.isError(result) || !isDictationSnapshot(result.value)) {
        reportOnboardingFailure();
        setUnread(true);
        return;
      }
      setUnread(false);
      setSnapshot(result.value);
    };
    const stopListening = subscribeDesktopEvent({
      event: DICTATION_CHANGED_EVENT,
      handler: () => {
        void refresh();
      },
      onError: reportOnboardingFailure,
    });
    reread.current = () => {
      void refresh();
    };
    void refresh();
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  /** Runs one native action and keeps the snapshot it returns. */
  const run = async (action: () => Promise<unknown>) => {
    const result = await Result.tryPromise(action);
    latest.current += 1;
    if (Result.isError(result) || !isDictationSnapshot(result.value)) {
      reportOnboardingFailure();
      setFailed(true);
      return null;
    }
    setFailed(false);
    setUnread(false);
    setSnapshot(result.value);
    return result.value;
  };

  const download = async () => {
    await run(async () => invoke<unknown>("dictation_download_model"));
  };

  const turnOn = async () => {
    const enabled = await run(async () =>
      invoke<unknown>("dictation_set_enabled", { enabled: true }),
    );
    if (enabled && needsDownload(enabled.model)) {
      await download();
    }
  };

  const reload = () => {
    reread.current();
  };

  return { download, failed, reload, snapshot, turnOn, unread };
};
