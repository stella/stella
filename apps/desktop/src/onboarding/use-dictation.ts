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

const DICTATION_FAILURES = [
  "accessibility",
  "microphone",
  "modelMissing",
  "transcription",
] as const;

type DictationFailure = (typeof DICTATION_FAILURES)[number];

export type DictationSnapshot = {
  available: boolean;
  enabled: boolean;
  failure: DictationFailure | null;
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

const isDictationSnapshot = (
  value: unknown,
): value is DictationSnapshot =>
  isRecord(value) &&
  typeof value["available"] === "boolean" &&
  typeof value["enabled"] === "boolean" &&
  (value["failure"] === null ||
    (typeof value["failure"] === "string" &&
      (DICTATION_FAILURES as readonly string[]).includes(value["failure"]))) &&
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
  /** `null` until the first read lands, or when the native side has none. */
  snapshot: DictationSnapshot | null;
  /** The last turn-on or download did not reach the native side. */
  failed: boolean;
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
  // Event reads and action results land in any order; only the most
  // recently issued one may set the snapshot.
  const latest = useRef(0);

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
      setSnapshot(
        Result.isOk(result) && isDictationSnapshot(result.value)
          ? result.value
          : null,
      );
    };
    const stopListening = subscribeDesktopEvent({
      event: DICTATION_CHANGED_EVENT,
      handler: () => {
        void refresh();
      },
      onError: reportOnboardingFailure,
    });
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

  return { download, failed, snapshot, turnOn };
};
