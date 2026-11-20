import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { usePrefersReducedMotion } from "@stll/ui/hooks/use-prefers-reduced-motion";
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
import type { DesktopTelemetryWindow } from "../telemetry/desktop-telemetry";
import {
  isMicrophoneLevel,
  isMicrophonesSnapshot,
  meterFraction,
  MICROPHONE_LEVEL_EVENT,
  MICROPHONE_TEST_ENDED_EVENT,
  microphoneChoice,
  selectedMicrophone,
  SYSTEM_DEFAULT,
  testMessage,
} from "./dictation-microphone";
import type {
  MicrophoneLevel,
  MicrophonesSnapshot,
} from "./dictation-microphone";
import { SettingsRow, settingsRowIds } from "./settings-layout";

/** With reduced motion the meter shows a level twice a second, not 25. */
const REDUCED_MOTION_INTERVAL_MS = 500;

/**
 * The microphone choice as a Settings row: the select beside its name, the
 * test under it. `focused` moves focus to the select once, for a link that
 * opens Settings on this choice.
 */
export const DictationMicrophoneRow = ({
  focused,
  onFocused,
}: {
  focused: boolean;
  onFocused: () => void;
}) => {
  const t = useTranslations("dictation.microphone");
  const ids = settingsRowIds("dictation-microphone");
  return (
    <DictationMicrophoneChoice
      focused={focused}
      labelledBy={ids.label}
      layout={({ select, test }) => (
        <SettingsRow
          description={t("hint")}
          footer={test}
          id="dictation-microphone"
          title={t("title")}
        >
          {select}
        </SettingsRow>
      )}
      onFocused={onFocused}
      telemetryWindow={DESKTOP_TELEMETRY_WINDOWS.main}
    />
  );
};

/** What the choice is drawn from: the select, and the test with its level
 *  and what it heard. */
type MicrophoneChoiceParts = { select: ReactNode; test: ReactNode };

/**
 * The microphone dictation records from, and a test of it: a live level
 * and whether speech is coming through. Settings and setup lay the parts
 * out their own way; both read and store the same choice.
 */
export const DictationMicrophoneChoice = ({
  focused = false,
  labelledBy,
  layout,
  onFocused,
  telemetryWindow,
}: {
  focused?: boolean;
  /** The id of the text that names the select. */
  labelledBy: string;
  layout: (parts: MicrophoneChoiceParts) => ReactNode;
  onFocused?: () => void;
  telemetryWindow: DesktopTelemetryWindow;
}) => {
  const t = useTranslations("dictation.microphone");
  const reportFailure = () => {
    reportChoiceFailure(telemetryWindow);
  };
  const command = async (name: string, args?: Record<string, unknown>) =>
    runCommand(name, telemetryWindow, args);
  const trigger = useRef<HTMLButtonElement>(null);
  const [snapshot, setSnapshot] = useState<MicrophonesSnapshot | null>(null);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState<MicrophoneLevel | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const lastShown = useRef(0);

  // The list follows devices plugged in or out while the window was away.
  useEffect(() => {
    let disposed = false;
    const read = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<unknown>("dictation_get_microphones"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result) || !isMicrophonesSnapshot(result.value)) {
        reportChoiceFailure(telemetryWindow);
        return;
      }
      setSnapshot(result.value);
    };
    const onFocus = () => {
      void read();
    };
    void read();
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [telemetryWindow]);

  useEffect(() => {
    if (focused && snapshot !== null) {
      trigger.current?.focus();
      trigger.current?.scrollIntoView({ block: "center" });
      onFocused?.();
    }
  }, [focused, onFocused, snapshot]);

  // Levels arrive only while a test runs; it stops when the window loses
  // focus or this row goes away.
  useEffect(() => {
    if (!testing) {
      return undefined;
    }
    const onError = () => {
      reportChoiceFailure(telemetryWindow);
    };
    const stopLevels = subscribeDesktopEvent<unknown>({
      event: MICROPHONE_LEVEL_EVENT,
      handler: ({ payload }) => {
        if (!isMicrophoneLevel(payload)) {
          return;
        }
        const now = performance.now();
        const settled = payload.status !== "listening" || payload.finished;
        if (
          reducedMotion &&
          !settled &&
          now - lastShown.current < REDUCED_MOTION_INTERVAL_MS
        ) {
          return;
        }
        lastShown.current = now;
        setLevel(payload);
      },
      onError,
    });
    const stopEnded = subscribeDesktopEvent({
      event: MICROPHONE_TEST_ENDED_EVENT,
      handler: () => {
        setTesting(false);
      },
      onError,
    });
    const onBlur = () => {
      setTesting(false);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      stopLevels();
      stopEnded();
      window.removeEventListener("blur", onBlur);
      void runCommand("dictation_test_microphone_stop", telemetryWindow);
    };
  }, [reducedMotion, telemetryWindow, testing]);

  if (snapshot === null) {
    return null;
  }
  const value = selectedMicrophone(snapshot);
  const defaultLabel =
    snapshot.defaultName === null
      ? t("systemDefault")
      : t("systemDefaultNamed", { name: snapshot.defaultName });
  const label = (option: unknown) => {
    if (option === SYSTEM_DEFAULT) {
      return defaultLabel;
    }
    const device = snapshot.devices.find(({ id }) => id === option);
    if (device) {
      return device.bluetooth
        ? t("bluetoothDevice", { name: device.name })
        : device.name;
    }
    return snapshot.chosenMissing === null
      ? null
      : t("notConnected", { name: snapshot.chosenMissing });
  };

  const choose = async (next: string) => {
    setTesting(false);
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("dictation_set_microphone", {
        id: microphoneChoice(next),
      }),
    );
    if (Result.isError(result) || !isMicrophonesSnapshot(result.value)) {
      reportFailure();
      return;
    }
    setSnapshot(result.value);
  };

  const startTest = async () => {
    setLevel(null);
    const started = await command("dictation_test_microphone_start", {
      id: microphoneChoice(value),
    });
    setTesting(started);
  };

  const message = testMessage(level);
  const device = level?.device ?? defaultLabel;

  // A fragment, so the component returns an element whatever the layout
  // hands back.
  return (
    <>
      {layout({
        select: (
          <Select
            onValueChange={(next) => {
              if (typeof next === "string") {
                void choose(next);
              }
            }}
            value={value}
          >
            <SelectTrigger
              aria-labelledby={labelledBy}
              className="w-56"
              ref={trigger}
            >
              <SelectValue>{label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={SYSTEM_DEFAULT}>{defaultLabel}</SelectItem>
              {snapshot.devices.map((input) => (
                <SelectItem key={input.id} value={input.id}>
                  {label(input.id)}
                </SelectItem>
              ))}
              {snapshot.chosenMissing === null ||
              snapshot.chosen === null ? null : (
                <SelectItem disabled value={snapshot.chosen}>
                  {label(snapshot.chosen)}
                </SelectItem>
              )}
            </SelectPopup>
          </Select>
        ),
        test: (
          <div
            className="flex min-w-0 flex-col gap-2"
            data-slot="microphone-test"
            data-status={level?.status ?? "idle"}
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => {
                  if (testing) {
                    setTesting(false);
                  } else {
                    void startTest();
                  }
                }}
                variant="outline"
              >
                {testing ? t("stopTest") : t("test")}
              </Button>
              {testing || level !== null ? (
                <LevelMeter
                  level={level}
                  label={t("level")}
                  still={reducedMotion}
                />
              ) : null}
            </div>
            {message === null ? null : (
              <p
                aria-live="polite"
                className={
                  message === "hearing"
                    ? "text-success-foreground text-sm"
                    : "text-destructive-foreground text-sm"
                }
              >
                {message === "hearing"
                  ? t("hearing")
                  : t("noSound", { device })}
                {level?.status === "zeros" ? (
                  <>
                    {" "}
                    <Button
                      onClick={() => {
                        void command("permissions_open_settings", {
                          permission: "microphone",
                        });
                      }}
                      size="inline"
                      variant="link"
                    >
                      {t("checkAccess")}
                    </Button>
                  </>
                ) : null}
              </p>
            )}
          </div>
        ),
      })}
    </>
  );
};

/** The input level as a bar, with its recent peak; levels only. */
const LevelMeter = ({
  label,
  level,
  still,
}: {
  label: string;
  level: MicrophoneLevel | null;
  still: boolean;
}) => {
  const fill = meterFraction(level?.levelDb ?? -Infinity);
  const peak = meterFraction(level?.peakDb ?? -Infinity);
  return (
    <div
      aria-label={label}
      aria-valuemax={0}
      aria-valuemin={-60}
      aria-valuenow={Math.round(Math.max(-60, level?.levelDb ?? -60))}
      className="bg-muted relative h-2 w-40 overflow-hidden rounded-full"
      data-slot="microphone-meter"
      role="meter"
    >
      <div
        className={
          still
            ? "bg-primary absolute inset-0 origin-left rtl:origin-right"
            : "bg-primary absolute inset-0 origin-left transition-transform duration-75 ease-out motion-reduce:transition-none rtl:origin-right"
        }
        style={{ transform: `scaleX(${fill})` }}
      />
      <div
        aria-hidden="true"
        className="bg-foreground-muted absolute inset-y-0 w-0.5"
        style={{ insetInlineStart: `calc(${peak * 100}% - 1px)` }}
      />
    </div>
  );
};

/** Runs a native command; false when it failed, which telemetry hears of. */
const runCommand = async (
  name: string,
  window: DesktopTelemetryWindow,
  args?: Record<string, unknown>,
) => {
  const result = await Result.tryPromise(async () => invoke(name, args));
  if (Result.isError(result)) {
    reportChoiceFailure(window);
    return false;
  }
  return true;
};

const reportChoiceFailure = (window: DesktopTelemetryWindow) => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window,
  });
};
