import { panic } from "better-result";
import { useRouter } from "expo-router";
import { Alert, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { useExternalSyncEffect, useLatestCallback } from "@stll/ui/effects";
import { Text } from "@stll/ui/text";

import { HOLD_TO_TALK_MS, useDictation } from "@/components/use-dictation";
import type {
  DictationNotice,
  DictationWaiting,
} from "@/components/use-dictation";
import { CheckIcon, DictateIcon, XIcon } from "@/icons.gen";
import type { Dictated } from "@/state/dictation";
import { DICTATION_TOTAL_MAX_MS } from "@/state/dictation-chunks";
import type { DictationField } from "@/state/dictation-kept";
import { useUiColors } from "@/theme";

/**
 * A microphone beside a text field: tap to dictate, done to transcribe,
 * the cross to drop the recording; or hold it to dictate while it is held.
 * While recording a bar shows how loud it hears the person. The text goes to `onText`, which adds it
 * to the field; while recording it says how long it has listened, and when
 * a dictation gives no text it says why. A dictation not transcribed yet
 * says so, with a retry and a discard; a text recovered from a closed field
 * of the same `field` kind can be pasted. Dictation as set up in Settings,
 * with the matter's names when the field belongs to one. `onBusyChange`
 * hears when a dictation starts recording and when it has settled, so the
 * form can hold its submit until the text has landed: a form that closes
 * mid-dictation drops the recording.
 */
export const DictateButton = ({
  disabled = false,
  field,
  matterId,
  onBusyChange,
  onText,
}: {
  disabled?: boolean;
  field: DictationField;
  matterId?: string | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  onText: (dictated: Dictated) => void;
}) => {
  const t = useTranslations("chat");
  const ui = useUiColors();
  const dictation = useDictation(onText, { disabled, field, matterId });
  const status = useDictationStatus(dictation);
  const busy = dictation.phase !== "idle";
  const reportBusy = useLatestCallback((value: boolean) => {
    onBusyChange?.(value);
  });
  useExternalSyncEffect(() => {
    reportBusy(busy);
  }, [busy, reportBusy]);

  return (
    <View className="gap-1">
      <KeptDictationBar dictation={dictation} disabled={disabled} />
      <View className="flex-row items-center justify-end gap-2">
        {status === undefined ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="flex-1"
            variant={
              dictation.notice === undefined && !dictation.noSignal
                ? "caption"
                : "error"
            }
          >
            {status}
          </Text>
        )}
        {dictation.phase === "recording" ? (
          <DictationLevel level={dictation.level} />
        ) : null}
        {dictation.phase === "idle" ? null : (
          <Button
            accessibilityLabel={t("dictationCancel")}
            disabled={dictation.phase !== "recording"}
            icon={<XIcon color={ui.foreground} size={18} />}
            onPress={dictation.cancel}
            size="icon-sm"
            variant="ghost"
          />
        )}
        {/* One button, the microphone and then done, so a press held on
            the microphone is still the same press when recording starts. */}
        {dictation.phase === "idle" ? (
          <Button
            accessibilityHint={t("dictateHoldHint")}
            accessibilityLabel={t("dictate")}
            delayLongPress={HOLD_TO_TALK_MS}
            disabled={disabled}
            icon={<DictateIcon color={ui.foreground} size={18} />}
            key="microphone"
            onLongPress={dictation.hold}
            onPress={dictation.start}
            onPressOut={dictation.release}
            size="icon-sm"
            variant="ghost"
          />
        ) : (
          <Button
            accessibilityLabel={t("dictationFinish")}
            disabled={dictation.phase !== "recording"}
            icon={<CheckIcon color={ui.foreground} size={18} />}
            key="microphone"
            loading={dictation.phase === "transcribing"}
            onPress={dictation.finish}
            onPressOut={dictation.release}
            size="icon-sm"
            variant="outline"
          />
        )}
      </View>
    </View>
  );
};

/**
 * A dictation field's kept dictations, above it while it is idle: one not
 * transcribed yet, with a retry and a discard, and a text recovered from a
 * closed field of the same kind, to paste.
 */
export const KeptDictationBar = ({
  dictation,
  disabled = false,
}: {
  dictation: ReturnType<typeof useDictation>;
  disabled?: boolean;
}) => {
  const t = useTranslations("chat");
  const ui = useUiColors();
  const router = useRouter();
  const { offered, phase, waiting } = dictation;
  const waitingText = useWaitingText(waiting);
  const confirmDiscard = useConfirmDiscard(dictation.discardWaiting);
  if (phase !== "idle" || (waiting === undefined && !offered)) {
    return null;
  }
  return (
    <View className="flex-row items-center justify-end gap-2">
      {waitingText === undefined ? null : (
        <Text
          accessibilityLiveRegion="polite"
          className="flex-1"
          variant={
            waiting?.status === "needs-person" ||
            waiting?.status === "needs-model"
              ? "error"
              : "caption"
          }
        >
          {waitingText}
        </Text>
      )}
      {offered ? (
        <Button
          disabled={disabled}
          onPress={dictation.pasteOffered}
          size="sm"
          variant="outline"
        >
          {t("dictationPaste")}
        </Button>
      ) : null}
      {waiting?.status === "needs-model" ? (
        <Button
          onPress={() => {
            router.push("/settings");
          }}
          size="sm"
          variant="outline"
        >
          {t("dictationOpenSettings")}
        </Button>
      ) : null}
      {waiting === undefined ? null : (
        <>
          <Button
            disabled={disabled || waiting.status === "retrying"}
            loading={waiting.status === "retrying"}
            onPress={dictation.retryWaiting}
            size="sm"
            variant="outline"
          >
            {t("retry")}
          </Button>
          <Button
            accessibilityLabel={t("dictationDiscard")}
            disabled={waiting.status === "retrying"}
            icon={<XIcon color={ui.foreground} size={18} />}
            onPress={confirmDiscard}
            size="icon-sm"
            variant="ghost"
          />
        </>
      )}
    </View>
  );
};

/**
 * Asks before a kept dictation is discarded: its recording is the only
 * copy of what was said.
 */
const useConfirmDiscard = (discard: () => void) => {
  const t = useTranslations("chat");
  return () => {
    Alert.alert(t("dictationDiscardTitle"), t("dictationDiscardMessage"), [
      { style: "cancel", text: t("dictationKeep") },
      { onPress: discard, style: "destructive", text: t("dictationDiscard") },
    ]);
  };
};

/**
 * How loud the microphone hears the person, as a short bar beside the
 * clock, from the level the recorder meters.
 */
export const DictationLevel = ({ level }: { level: number }) => (
  <View
    accessibilityElementsHidden
    className="bg-secondary h-1.5 w-10 overflow-hidden rounded-full"
    importantForAccessibility="no-hide-descendants"
  >
    <View
      className="bg-foreground h-full rounded-full"
      style={{ width: `${Math.round(level * 100)}%` }}
    />
  </View>
);

/** What the microphone says next to it: how long it listened, or why a dictation gave no text. */
const useDictationStatus = ({
  elapsedMs,
  noSignal,
  notice,
  phase,
}: Pick<
  ReturnType<typeof useDictation>,
  "elapsedMs" | "noSignal" | "notice" | "phase"
>): string | undefined => {
  const t = useTranslations("chat");
  if (noSignal) {
    return t("dictationNoSignal");
  }
  if (phase === "recording") {
    return t("dictationListening", {
      elapsed: dictationClock(elapsedMs),
      limit: dictationClock(DICTATION_TOTAL_MAX_MS),
    });
  }
  if (phase === "transcribing") {
    return t("dictationTranscribing");
  }
  if (notice === undefined) {
    return undefined;
  }
  const noticeText = {
    denied: t("dictationDenied"),
    failed: t("dictationFailed"),
    silent: t("dictationSilent"),
  } as const satisfies Record<DictationNotice, string>;
  return noticeText[notice];
};

/** What a field says of a dictation not transcribed yet. */
const useWaitingText = (
  waiting: DictationWaiting | undefined,
): string | undefined => {
  const t = useTranslations("chat");
  if (waiting === undefined) {
    return undefined;
  }
  switch (waiting.status) {
    case "retrying":
      return t("dictationTranscribing");
    case "waiting":
      return t(waiting.earlier ? "dictationKeptEarlier" : "dictationKept");
    case "needs-person":
      return t("dictationKeptRefused");
    case "needs-model":
      return t("dictationKeptModelWithdrawn");
    default:
      waiting.status satisfies never;
      return panic("A kept dictation has no known status");
  }
};

/** Minutes and seconds, as a recorder counts: 0:07, 1:00. */
export const dictationClock = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
