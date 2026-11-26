import { useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";

import { useMountEffect } from "@stll/ui/effects";

import { subscribeDesktopEvent } from "../shared/desktop-events";
import { isHoldKey } from "../shared/hold-key";
import type { HoldKey } from "../shared/hold-key";
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
  "nothingHeard",
  "passwordField",
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
  /** Whether the transcribed text goes through stella to the organization's
   *  AI provider before it is typed; on by default. */
  cleanup: boolean;
  /** Whether the account has stella AI transcription; without it the
   *  choice of where speech is transcribed is not offered. */
  cloudAvailable: boolean;
  /** The stella AI model the user picked; null: the region's default. */
  cloudModel: string | null;
  /** A model was stored but cannot be read: none is shown as chosen, and
   *  nothing goes to stella AI until the speaker picks one. */
  cloudModelUnreadable?: boolean | undefined;
  /** Names and terms stella should spell the speaker's way. */
  customWords: string[];
  /** Where speech is transcribed. */
  destination: "cloud" | "local";
  enabled: boolean;
  failure: string | null;
  /** The key dictation listens for. */
  holdKey: HoldKey;
  /** Control, Option (Alt) and Space: the `combination` choice. */
  keys: ShortcutKeys;
  model: DictationModel;
  modelBytes: number;
  phase: "idle" | "recording" | "transcribing";
  /** Whether cleanup also gets the text before the cursor. */
  shareTextBeforeCursor: boolean;
  /** Whether cleanup also gets the focused window's title. */
  shareWindowTitle: boolean;
  shortcutTaken: boolean;
  /** Whether this computer can read the text before the cursor. */
  textBeforeCursorAvailable: boolean;
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
  typeof value["cleanup"] === "boolean" &&
  typeof value["cloudAvailable"] === "boolean" &&
  (value["cloudModel"] === null || typeof value["cloudModel"] === "string") &&
  Array.isArray(value["customWords"]) &&
  value["customWords"].every((word) => typeof word === "string") &&
  (value["destination"] === "local" || value["destination"] === "cloud") &&
  typeof value["enabled"] === "boolean" &&
  (value["failure"] === null || typeof value["failure"] === "string") &&
  isHoldKey(value["holdKey"]) &&
  isShortcutKeys(value["keys"]) &&
  isModel(value["model"]) &&
  typeof value["modelBytes"] === "number" &&
  (value["phase"] === "idle" ||
    value["phase"] === "recording" ||
    value["phase"] === "transcribing") &&
  typeof value["shareTextBeforeCursor"] === "boolean" &&
  typeof value["shareWindowTitle"] === "boolean" &&
  typeof value["shortcutTaken"] === "boolean" &&
  typeof value["textBeforeCursorAvailable"] === "boolean";

/** A model that is neither on disk nor on its way. */
const needsDownload = (model: DictationModel) =>
  model.status === "missing" || model.status === "failed";

export type DictationControls = {
  /** `null` until a read lands. */
  snapshot: DictationSnapshot | null;
  /** The last change did not reach the native side. */
  failed: boolean;
  /**
   * The last read did not land; `snapshot` is still the one before it, so
   * setup keeps what it showed.
   */
  unread: boolean;
  /** Reads the state again. */
  reload: () => void;
  /** Turns dictation on; the speech model is downloaded on its own.
   *  Resolves to whether it is on. */
  turnOn: () => Promise<boolean>;
  /** Starts the speech model download unless the model is on its way or
   *  in place. */
  download: () => Promise<void>;
  setCleanup: (enabled: boolean) => Promise<void>;
  setDestination: (
    destination: DictationSnapshot["destination"],
  ) => Promise<void>;
  setCloudModel: (modelId: string) => Promise<void>;
  setShare: (piece: DictationSharedPiece, enabled: boolean) => Promise<void>;
  /** Resolves to whether the native side stored the list. */
  setCustomWords: (words: string[]) => Promise<boolean>;
};

/** What cleanup may also read, each behind its own switch. */
type DictationSharedPiece = "textBeforeCursor" | "windowTitle";

/**
 * The live dictation state for setup, and the actions setup offers. The
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

  useMountEffect(() => {
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
  });

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
    if (snapshot !== null && !needsDownload(snapshot.model)) {
      return;
    }
    await run(async () => invoke<unknown>("dictation_download_model"));
  };

  const turnOn = async () =>
    (
      await run(async () =>
        invoke<unknown>("dictation_set_enabled", { enabled: true }),
      )
    )?.enabled === true;

  const setCleanup = async (enabled: boolean) => {
    await run(async () =>
      invoke<unknown>("dictation_set_cleanup", { enabled }),
    );
  };

  const setDestination = async (
    destination: DictationSnapshot["destination"],
  ) => {
    await run(async () =>
      invoke<unknown>("dictation_set_destination", { destination }),
    );
  };

  const setCloudModel = async (modelId: string) => {
    await run(async () =>
      invoke<unknown>("dictation_set_cloud_model", { modelId }),
    );
  };

  const setShare = async (piece: DictationSharedPiece, enabled: boolean) => {
    await run(async () =>
      piece === "windowTitle"
        ? invoke<unknown>("dictation_set_share_window_title", { enabled })
        : invoke<unknown>("dictation_set_share_text_before_cursor", {
            enabled,
          }),
    );
  };

  const setCustomWords = async (words: string[]) =>
    (await run(async () =>
      invoke<unknown>("dictation_set_custom_words", { words }),
    )) !== null;

  const reload = () => {
    reread.current();
  };

  return {
    download,
    failed,
    reload,
    setCleanup,
    setCloudModel,
    setCustomWords,
    setDestination,
    setShare,
    snapshot,
    turnOn,
    unread,
  };
};
