import { useEffect, useEffectEvent } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { useDictation } from "@/components/use-dictation";
import type { DictationNotice } from "@/components/use-dictation";
import { CheckIcon, DictateIcon, XIcon } from "@/icons.gen";
import { DICTATION_MAX_SECONDS } from "@/state/dictation";
import { useUiColors } from "@/theme";

/**
 * A microphone beside a text field: tap to dictate, done to transcribe,
 * the cross to drop the recording. The text goes to `onText`, which adds it
 * to the field; while recording it says how long it has listened, and when
 * a dictation gives no text it says why. Dictation as set up in Settings,
 * with the matter's names when the field belongs to one. `onBusyChange`
 * hears when a dictation starts recording and when it has settled, so the
 * form can hold its submit until the text has landed: a form that closes
 * mid-dictation drops the recording.
 */
export const DictateButton = ({
  disabled = false,
  matterId,
  onBusyChange,
  onText,
}: {
  disabled?: boolean;
  matterId?: string | undefined;
  onBusyChange?: ((busy: boolean) => void) | undefined;
  onText: (text: string) => void;
}) => {
  const t = useTranslations("chat");
  const ui = useUiColors();
  const dictation = useDictation(onText, { matterId });
  const status = useDictationStatus(dictation);
  const busy = dictation.phase !== "idle";
  const reportBusy = useEffectEvent((value: boolean) => {
    onBusyChange?.(value);
  });
  useEffect(() => {
    reportBusy(busy);
  }, [busy]);

  return (
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
  );
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
      limit: dictationClock(DICTATION_MAX_SECONDS * 1000),
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

/** Minutes and seconds, as a recorder counts: 0:07, 1:00. */
export const dictationClock = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
