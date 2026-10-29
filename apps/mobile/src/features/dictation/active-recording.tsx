import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { Text } from "@/components/ui/text";
import type { AccessTokenSource } from "@/connection/session";
import { ActionButton } from "@/features/dictation/action-button";
import { formatDuration } from "@/features/dictation/duration";
import { EndSheet } from "@/features/dictation/end-sheet";
import { canApplyRecorderAction } from "@/features/dictation/recorder-state";
import type { RecordingSignal } from "@/features/dictation/signal";
import { Waveform } from "@/features/dictation/waveform";
import type {
  DictationRecorder,
  NativeDraft,
} from "@/native/dictation-recorder";

export const ActiveRecording = ({
  active,
  pending,
  contextName,
  signal,
  source,
  recorder,
  run,
  remove,
  onClose,
}: {
  active: NativeDraft;
  pending: boolean;
  contextName: string | null;
  signal: RecordingSignal;
  source: AccessTokenSource;
  recorder: DictationRecorder;
  run: (operation: () => Promise<NativeDraft | null>) => void;
  remove: (draft: NativeDraft) => void;
  onClose: () => void;
}) => {
  const t = useTranslations("dictation");
  const timers = useTranslations("timers");
  const format = useFormatter();
  const { pause, resume, addMarker, finish } = recorder;
  const statusLabels = {
    recording: t("recording"),
    paused: timers("paused"),
    finished: t("finished"),
  } satisfies Record<NativeDraft["status"], string>;
  return (
    <>
      {active.matterId === null ? null : (
        <Text variant="caption">{contextName ?? t("matterSelected")}</Text>
      )}
      <Text
        className="text-center"
        variant="display"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {formatDuration(active.elapsedMs, format)}
      </Text>
      <Waveform levels={active.levels} signal={signal} />
      {signal === "no-signal" && active.status === "recording" ? (
        <Text accessibilityRole="alert" variant="error">
          {t("noSignal")}
        </Text>
      ) : null}
      <Text className="text-center" variant="caption">
        {statusLabels[active.status]}
      </Text>
      <View className="flex-row flex-wrap justify-center gap-3">
        {active.status === "finished" ? null : (
          <>
            <ActionButton
              disabled={pending}
              label={
                active.status === "recording"
                  ? timers("pause")
                  : timers("resume")
              }
              onPress={() => {
                run(
                  async () =>
                    await (active.status === "recording"
                      ? pause(active.id)
                      : resume(active.id)),
                );
              }}
            />
            <ActionButton
              disabled={
                pending || !canApplyRecorderAction(active.status, "marker")
              }
              label={t("marker")}
              onPress={() => {
                run(async () => await addMarker(active.id));
              }}
            />
            <ActionButton
              disabled={pending}
              label={t("stop")}
              onPress={() => {
                run(async () => await finish(active.id));
              }}
            />
          </>
        )}
        <ActionButton
          disabled={pending || !canApplyRecorderAction(active.status, "delete")}
          label={t("delete")}
          onPress={() => {
            remove(active);
          }}
        />
      </View>
      {active.markers.length === 0 ? null : (
        <View className="gap-2">
          <Text variant="section">{t("markers")}</Text>
          {[...new Set(active.markers)].map((time) => (
            <Text key={time} variant="caption">
              {formatDuration(time, format)}
            </Text>
          ))}
        </View>
      )}
      {active.status === "finished" ? (
        <EndSheet
          draft={active}
          source={source}
          recorder={recorder}
          onClose={onClose}
        />
      ) : null}
    </>
  );
};
