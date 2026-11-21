import { useEffect, useEffectEvent } from "react";

import { panic } from "better-result";
import { Alert, View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { useDictation } from "@/components/use-dictation";
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
 * the cross to drop the recording. The text goes to `onText`, which adds it
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
  const reportBusy = useEffectEvent((value: boolean) => {
    onBusyChange?.(value);
  });
  useEffect(() => {
    reportBusy(busy);
  }, [busy]);

  return (
    <View className="gap-1">
      <KeptDictationBar dictation={dictation} disabled={disabled} />
      <View className="flex-row items-center justify-end gap-2">
        {status === undefined ? null : (
          <Text
            accessibilityLiveRegion="polite"
            className="flex-1"
            variant={dictation.notice === undefined ? "caption" : "error"}
          >
            {status}
          </Text>
        )}
        {dictation.phase === "idle" ? (
          <Button
            accessibilityLabel={t("dictate")}
            disabled={disabled}
            icon={<DictateIcon color={ui.foreground} size={18} />}
            onPress={dictation.start}
            size="icon-sm"
            variant="ghost"
          />
        ) : (
          <>
            <Button
              accessibilityLabel={t("dictationCancel")}
              disabled={dictation.phase !== "recording"}
              icon={<XIcon color={ui.foreground} size={18} />}
              onPress={dictation.cancel}
              size="icon-sm"
              variant="ghost"
            />
            <Button
              accessibilityLabel={t("dictationFinish")}
              disabled={dictation.phase !== "recording"}
              icon={<CheckIcon color={ui.foreground} size={18} />}
              loading={dictation.phase === "transcribing"}
              onPress={dictation.finish}
              size="icon-sm"
              variant="outline"
            />
          </>
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
          variant={waiting?.status === "needs-person" ? "error" : "caption"}
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

/** What the microphone says next to it: how long it listened, or why a dictation gave no text. */
const useDictationStatus = ({
  elapsedMs,
  notice,
  phase,
}: Pick<ReturnType<typeof useDictation>, "elapsedMs" | "notice" | "phase">):
  string | undefined => {
  const t = useTranslations("chat");
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
