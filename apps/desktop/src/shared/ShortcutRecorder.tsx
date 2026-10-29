import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import type { DesktopTelemetryWindow } from "../telemetry/desktop-telemetry";
import { Keycaps } from "./Keycaps";
import {
  formatShortcut,
  heldModifiers,
  isShortcutCheck,
  isShortcutUpdate,
  modifierLabel,
  modifierOfKey,
  orderModifiers,
  sameShortcut,
  shortcutKeycaps,
} from "./shortcut-keys";
import type {
  ClipboardShortcutSnapshot,
  KeyboardLayout,
  ShortcutKeys,
  ShortcutModifier,
  ShortcutRejection,
} from "./shortcut-keys";
import { ShortcutRejectionText } from "./ShortcutRejectionText";
import { DESKTOP_PLATFORM } from "./use-clipboard-shortcut";

type ShortcutRecorderProps = {
  current: ShortcutKeys;
  layout: KeyboardLayout | null;
  onCancel: () => void;
  onSaved: (snapshot: ClipboardShortcutSnapshot) => void;
  window: DesktopTelemetryWindow;
};

/**
 * Records a new clipboard shortcut. The current one is released while this
 * is mounted, so its combination reaches the window instead of the OS; it is
 * registered again when recording ends, whichever way it ends.
 */
export const ShortcutRecorder = ({
  current,
  layout,
  onCancel,
  onSaved,
  window: telemetryWindow,
}: ShortcutRecorderProps) => {
  const t = useTranslations("shortcut");
  const locale = useLocale();
  const [state, setState] = useState<RecorderState>({
    held: [],
    notice: null,
    status: "listening",
  });
  const generation = useRef(0);

  useEffect(() => {
    const report = () => reportShortcutFailure(telemetryWindow);
    void invoke("shortcut_pause").catch(report);
    return () => {
      // A no-op after a save, which registered the new shortcut already.
      void invoke("shortcut_resume").catch(report);
    };
  }, [telemetryWindow]);

  useEffect(() => {
    const check = async (candidate: ShortcutKeys) => {
      generation.current += 1;
      const request = generation.current;
      setState({ candidate, status: "checking" });
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("shortcut_check", { keys: candidate }),
      );
      if (request !== generation.current) {
        return;
      }
      if (Result.isError(result) || !isShortcutCheck(result.value)) {
        reportShortcutFailure(telemetryWindow);
        setState({ held: [], notice: { type: "error" }, status: "listening" });
        return;
      }
      if (result.value.status === "rejected") {
        setState({
          held: [],
          notice: {
            candidate,
            rejection: result.value.rejection,
            type: "rejected",
          },
          status: "listening",
        });
        return;
      }
      if (sameShortcut(candidate, current)) {
        setState({ held: [], notice: { type: "same" }, status: "listening" });
        return;
      }
      setState({ candidate, status: "ready" });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const held = heldModifiers(event);
      // Tab moves focus, and a bare Enter or Space activates the focused
      // button; neither could be a shortcut without a modifier anyway.
      if (
        event.key === "Tab" ||
        (held.length === 0 && (event.key === "Enter" || event.key === " "))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && held.length === 0) {
        onCancel();
        return;
      }
      if (event.repeat) {
        return;
      }
      if (modifierOfKey(event.key)) {
        generation.current += 1;
        setState({ held, notice: null, status: "listening" });
        return;
      }
      void check({ code: event.code, modifiers: held });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!modifierOfKey(event.key)) {
        return;
      }
      setState((previous) =>
        previous.status === "listening"
          ? {
              held: heldModifiers(event),
              notice: previous.notice,
              status: "listening",
            }
          : previous,
      );
    };
    // Recording only makes sense while this window has the keyboard; leaving
    // it ends recording so the shortcut is not left released.
    const onBlur = () => onCancel();

    globalThis.addEventListener("keydown", onKeyDown, true);
    globalThis.addEventListener("keyup", onKeyUp, true);
    globalThis.addEventListener("blur", onBlur);
    return () => {
      generation.current += 1;
      globalThis.removeEventListener("keydown", onKeyDown, true);
      globalThis.removeEventListener("keyup", onKeyUp, true);
      globalThis.removeEventListener("blur", onBlur);
    };
  }, [current, onCancel, telemetryWindow]);

  const save = async (candidate: ShortcutKeys) => {
    setState({ candidate, status: "saving" });
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("shortcut_set", { keys: candidate }),
    );
    if (Result.isError(result) || !isShortcutUpdate(result.value)) {
      reportShortcutFailure(telemetryWindow);
      setState({ held: [], notice: { type: "error" }, status: "listening" });
      return;
    }
    if (result.value.status === "saved") {
      onSaved(result.value.snapshot);
      return;
    }
    // A refused candidate put the previous shortcut back; release it again
    // while recording continues.
    void invoke("shortcut_pause").catch(() =>
      reportShortcutFailure(telemetryWindow),
    );
    setState({
      held: [],
      notice: {
        candidate,
        rejection: result.value.rejection,
        type: "rejected",
      },
      status: "listening",
    });
  };

  const shown =
    state.status === "listening"
      ? orderModifiers(state.held, DESKTOP_PLATFORM).map((modifier) => ({
          id: modifier,
          label: modifierLabel({
            locale,
            modifier,
            platform: DESKTOP_PLATFORM,
          }),
        }))
      : shortcutKeycaps({
          keys: state.candidate,
          layout,
          locale,
          platform: DESKTOP_PLATFORM,
        });
  const label = (keys: ShortcutKeys) =>
    formatShortcut({ keys, layout, locale, platform: DESKTOP_PLATFORM });

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">{t("recording")}</p>
      <div className="flex min-h-8 items-center gap-2">
        {shown.length > 0 ? (
          <Keycaps caps={shown.map((cap) => ({ ...cap, state: "down" }))} />
        ) : (
          <Keycaps
            caps={[{ id: "placeholder", label: "…" }]}
            className="text-muted-foreground opacity-60"
          />
        )}
      </div>
      <p
        aria-live="polite"
        className={
          state.status === "listening" && state.notice
            ? "text-destructive-foreground min-h-5 text-sm"
            : "text-muted-foreground min-h-5 text-sm"
        }
      >
        {recorderMessage({
          label,
          layout,
          state,
          text: {
            addKey: t("addKey"),
            errorSave: t("errorSave"),
            same: t("same"),
            waiting: t("waiting"),
          },
          confirm: (shortcut) => t("confirm", { shortcut }),
        })}
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} variant="ghost">
          {t("cancel")}
        </Button>
        {state.status === "ready" || state.status === "saving" ? (
          <Button
            disabled={state.status === "saving"}
            onClick={() => {
              void save(state.candidate);
            }}
          >
            {t("use", { shortcut: label(state.candidate) })}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

type RecorderNotice =
  | { candidate: ShortcutKeys; rejection: ShortcutRejection; type: "rejected" }
  | { type: "same" }
  | { type: "error" };

type RecorderState =
  | {
      held: ShortcutModifier[];
      notice: RecorderNotice | null;
      status: "listening";
    }
  | { candidate: ShortcutKeys; status: "checking" }
  | { candidate: ShortcutKeys; status: "ready" }
  | { candidate: ShortcutKeys; status: "saving" };

type RecorderMessageOptions = {
  confirm: (shortcut: string) => string;
  label: (keys: ShortcutKeys) => string;
  layout: KeyboardLayout | null;
  state: RecorderState;
  text: { addKey: string; errorSave: string; same: string; waiting: string };
};

function recorderMessage({
  confirm,
  label,
  layout,
  state,
  text,
}: RecorderMessageOptions): ReactNode {
  switch (state.status) {
    case "checking":
    case "saving":
      return null;
    case "ready":
      return confirm(label(state.candidate));
    case "listening":
      return listeningMessage({
        held: state.held,
        layout,
        notice: state.notice,
        text,
      });
    default:
      state satisfies never;
      return panic("Unknown shortcut recorder state.");
  }
}

function listeningMessage({
  held,
  layout,
  notice,
  text,
}: {
  held: readonly ShortcutModifier[];
  layout: KeyboardLayout | null;
  notice: RecorderNotice | null;
  text: RecorderMessageOptions["text"];
}): ReactNode {
  if (!notice) {
    return held.length > 0 ? text.addKey : text.waiting;
  }
  switch (notice.type) {
    case "error":
      return text.errorSave;
    case "same":
      return text.same;
    case "rejected":
      return (
        <ShortcutRejectionText
          candidate={notice.candidate}
          layout={layout}
          rejection={notice.rejection}
        />
      );
    default:
      notice satisfies never;
      return panic("Unknown shortcut recorder notice.");
  }
}

function reportShortcutFailure(window: DesktopTelemetryWindow) {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.shortcutUpdate,
    window,
  });
}
