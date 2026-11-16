import { useCallback, useEffect, useState } from "react";

import { panic } from "better-result";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { Keycaps } from "../shared/Keycaps";
import type { Keycap } from "../shared/Keycaps";
import {
  formatShortcut,
  heldModifiers,
  keyLabel,
  modifierLabel,
  modifierOfKey,
  orderModifiers,
} from "../shared/shortcut-keys";
import type {
  KeyboardLayout,
  ShortcutKeys,
  ShortcutModifier,
} from "../shared/shortcut-keys";
import { ShortcutRecorder } from "../shared/ShortcutRecorder";
import {
  DESKTOP_PLATFORM,
  useClipboardShortcut,
  useKeyboardLayout,
} from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import { reportOnboardingFailure } from "./onboarding-telemetry";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";
import { feedbackForKey, feedbackForModifiers } from "./try-shortcut";
import type { TryFeedback } from "./try-shortcut";

/** How long a wrong-key hint stays before the keycaps settle again. */
const HINT_MS = 2600;

/**
 * The last step: the user presses the real shortcut. Keycaps light up while
 * held and a wrong key is named, from ordinary key events while this window
 * is in front; no keystroke permission is involved. The press itself reaches
 * the native shortcut handler, which moves setup on.
 */
export const TryItStep = ({ onBack, onContinue, snapshot }: StepProps) => {
  const t = useTranslations("onboarding");
  const shortcutT = useTranslations("shortcut");
  const locale = useLocale();
  const layout = useKeyboardLayout();
  const [shortcut, setShortcut] = useClipboardShortcut(reportOnboardingFailure);
  const [recordingRequested, setRecordingRequested] = useState(false);
  const [held, setHeld] = useState<ShortcutModifier[]>([]);
  const [feedback, setFeedback] = useState<TryFeedback>({ type: "idle" });
  const [focused, setFocused] = useState(() => document.hasFocus());
  const stopRecording = useCallback(() => setRecordingRequested(false), []);

  const recording =
    recordingRequested || shortcut?.registration === "unavailable";
  const keys = shortcut?.keys ?? null;

  useEffect(() => {
    if (recording || !keys) {
      return undefined;
    }
    const focusTimer = window.setTimeout(() => {
      setFocused(document.hasFocus());
    }, 0);
    let hintTimer: number | undefined;
    const showFeedback = (next: TryFeedback) => {
      window.clearTimeout(hintTimer);
      setFeedback(next);
      if (next.type !== "idle" && next.type !== "progress") {
        hintTimer = window.setTimeout(() => {
          setFeedback({ type: "idle" });
        }, HINT_MS);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const modifiers = heldModifiers(event);
      if (
        event.key === "Tab" ||
        event.key === "Escape" ||
        (modifiers.length === 0 && (event.key === "Enter" || event.key === " "))
      ) {
        return;
      }
      event.preventDefault();
      setHeld(modifiers);
      if (modifierOfKey(event.key)) {
        showFeedback(feedbackForModifiers(keys, modifiers));
        return;
      }
      showFeedback(
        feedbackForKey({ code: event.code, held: modifiers, shortcut: keys }),
      );
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!modifierOfKey(event.key)) {
        return;
      }
      const modifiers = heldModifiers(event);
      setHeld(modifiers);
      setFeedback((previous) =>
        previous.type === "extraModifier" || previous.type === "progress"
          ? feedbackForModifiers(keys, modifiers)
          : previous,
      );
    };
    const onBlur = () => {
      setHeld([]);
      setFocused(false);
    };
    const onFocus = () => setFocused(true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(hintTimer);
      window.clearTimeout(focusTimer);
      setHeld([]);
      setFeedback({ type: "idle" });
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, [keys, recording]);

  const label = (value: ShortcutKeys) =>
    formatShortcut({ keys: value, layout, locale, platform: DESKTOP_PLATFORM });

  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <h1 className="text-xl font-semibold">{t("tryTitle")}</h1>
        {keys ? (
          <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
            {t("tryBody", { shortcut: label(keys) })}
          </p>
        ) : null}
        {shortcut?.registration === "unavailable" ? (
          <p
            className="text-destructive-foreground max-w-md text-sm"
            role="alert"
          >
            {shortcutT("unavailable", { shortcut: label(shortcut.keys) })}
          </p>
        ) : null}
        {recording && shortcut ? (
          <div className="w-full max-w-md text-start">
            <ShortcutRecorder
              current={shortcut.keys}
              layout={layout}
              onCancel={stopRecording}
              onSaved={(next) => {
                setShortcut(next);
                setRecordingRequested(false);
              }}
              window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
            />
          </div>
        ) : null}
        {!recording && keys ? (
          <>
            <div
              className={cn(
                "rounded-2xl border border-dashed p-4 transition-opacity motion-reduce:transition-none",
                focused ? "opacity-100" : "opacity-50",
              )}
            >
              <Keycaps
                caps={liveKeycaps({ feedback, held, keys, layout, locale })}
                size="lg"
              />
            </div>
            <p
              aria-live="polite"
              className={cn(
                "min-h-10 max-w-md text-sm",
                isHint(feedback) && focused
                  ? "text-destructive-foreground"
                  : "text-muted-foreground",
              )}
            >
              {focused
                ? feedbackMessage({ feedback, keys, layout, locale, t })
                : t("tryUnfocused")}
            </p>
            <Button onClick={() => setRecordingRequested(true)} variant="ghost">
              {t("tryChange")}
            </Button>
          </>
        ) : null}
      </div>
      <StepFooter
        onBack={onBack}
        secondary={
          <Button onClick={onContinue} variant="ghost">
            {t("skip")}
          </Button>
        }
        snapshot={snapshot}
      />
    </>
  );
};

function isHint(feedback: TryFeedback) {
  return (
    feedback.type === "extraModifier" ||
    feedback.type === "missingModifiers" ||
    feedback.type === "wrongKey"
  );
}

type LiveKeycapsOptions = {
  feedback: TryFeedback;
  held: readonly ShortcutModifier[];
  keys: ShortcutKeys;
  layout: KeyboardLayout | null;
  locale: string;
};

function liveKeycaps({
  feedback,
  held,
  keys,
  layout,
  locale,
}: LiveKeycapsOptions): Keycap[] {
  const caps: Keycap[] = [
    ...orderModifiers(keys.modifiers, DESKTOP_PLATFORM).map(
      (modifier): Keycap => ({
        id: modifier,
        label: modifierLabel({ locale, modifier, platform: DESKTOP_PLATFORM }),
        state: held.includes(modifier) ? "down" : "idle",
      }),
    ),
    {
      id: "key",
      label: keyLabel(keys.code, layout),
      state: feedback.type === "missingModifiers" ? "wrong" : "idle",
    },
  ];
  if (feedback.type === "extraModifier") {
    caps.push({
      id: "extra",
      label: modifierLabel({
        locale,
        modifier: feedback.modifier,
        platform: DESKTOP_PLATFORM,
      }),
      state: "wrong",
    });
  }
  if (feedback.type === "wrongKey") {
    caps.push({
      id: "extra",
      label: keyLabel(feedback.code, layout),
      state: "wrong",
    });
  }
  return caps;
}

type FeedbackMessageOptions = {
  feedback: TryFeedback;
  keys: ShortcutKeys;
  layout: KeyboardLayout | null;
  locale: string;
  t: ReturnType<typeof useTranslations<"onboarding">>;
};

function feedbackMessage({
  feedback,
  keys,
  layout,
  locale,
  t,
}: FeedbackMessageOptions): string {
  const modifierList = (modifiers: readonly ShortcutModifier[]) =>
    new Intl.ListFormat(locale, { type: "conjunction" }).format(
      orderModifiers(modifiers, DESKTOP_PLATFORM).map((modifier) =>
        modifierLabel({ locale, modifier, platform: DESKTOP_PLATFORM }),
      ),
    );
  const key = keyLabel(keys.code, layout);
  switch (feedback.type) {
    case "idle":
      return t("tryWaiting");
    case "progress":
      return t("tryKeepGoing");
    case "extraModifier":
      return t("tryExtraModifier", {
        pressed: modifierLabel({
          locale,
          modifier: feedback.modifier,
          platform: DESKTOP_PLATFORM,
        }),
        shortcut: formatShortcut({
          keys,
          layout,
          locale,
          platform: DESKTOP_PLATFORM,
        }),
      });
    case "missingModifiers":
      return t("tryMissingModifiers", {
        key,
        modifiers: modifierList(feedback.missing),
      });
    case "wrongKey":
      return t("tryWrongKey", {
        key,
        modifiers: modifierList(keys.modifiers),
        pressed: keyLabel(feedback.code, layout),
      });
    default:
      feedback satisfies never;
      return panic("Unknown try-it feedback.");
  }
}
