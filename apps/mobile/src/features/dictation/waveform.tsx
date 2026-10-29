import { View } from "react-native";

import { waveformLevel } from "@/features/dictation/signal";
import type { RecordingSignal } from "@/features/dictation/signal";
import type { NativeDraft } from "@/native/dictation-recorder";

export const Waveform = ({
  levels,
  signal,
}: {
  levels: NativeDraft["levels"];
  signal: RecordingSignal;
}) => (
  <View
    accessible={false}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    className="h-24 flex-row items-center justify-end gap-0.5 overflow-hidden"
  >
    {signal === "no-signal" ? (
      <View className="bg-destructive h-0.5 w-full" />
    ) : (
      levels.slice(-160).map((level) => (
        <View
          key={level.timeMs}
          className={
            level.db <= -54
              ? "bg-muted-foreground rounded-full opacity-30"
              : "bg-foreground rounded-full"
          }
          style={{
            width: 2,
            height:
              level.db <= -54 ? 2 : Math.max(2, waveformLevel(level.db) * 88),
          }}
        />
      ))
    )}
  </View>
);
