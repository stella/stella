import { useEffect, useState } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";
import { dictationSessionEndHandler } from "@/features/dictation/lifecycle";
import {
  canRecordDictation,
  createDictationRecorder,
} from "@/native/dictation-recorder";

export const DictationSessionBoundary = () => {
  const { registerBeforeSessionEnd } = useSession();
  const [failure, setFailure] = useState(false);
  const t = useTranslations("dictation");
  useEffect(() => {
    if (!canRecordDictation()) {
      return;
    }
    return registerBeforeSessionEnd(
      dictationSessionEndHandler({
        recorderFor: createDictationRecorder,
        onFailure: () => {
          setFailure(true);
        },
      }),
    );
  }, [registerBeforeSessionEnd]);
  return failure ? (
    <View className="bg-background px-4 py-2">
      <Text accessibilityRole="alert" variant="error">
        {t("failed")}
      </Text>
    </View>
  ) : null;
};
