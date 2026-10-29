import { Stack, useRouter } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";
import { ActionButton } from "@/features/dictation/action-button";
import {
  useDictationIdentity,
  useDictationRecorder,
} from "@/features/dictation/identity";
import { Recorder } from "@/features/dictation/recorder";

export const DictationScreen = () => {
  const identity = useDictationIdentity();
  const recorder = useDictationRecorder();
  const t = useTranslations("dictation");
  const tabs = useTranslations("tabs");
  const writes = useTranslations("writes");
  const router = useRouter();
  const { state, end } = useSession();
  return (
    <>
      <Stack.Screen
        options={{
          title: t("title"),
          unstable_headerLeftItems: () => [
            {
              type: "button",
              label: tabs("close"),
              onPress: () => {
                router.back();
              },
            },
          ],
        }}
      />
      {identity.kind === "signed-in" &&
      recorder !== null &&
      state.status === "signed-in" ? (
        <Recorder
          source={state.source}
          recorder={recorder}
          key={JSON.stringify([
            identity.scope.serverOrigin,
            identity.scope.userId,
          ])}
        />
      ) : (
        <View className="p-5">
          {identity.kind === "signed-out" && state.status === "signed-in" ? (
            <ActionButton
              label={writes("signInAgain")}
              onPress={() => {
                end(state.source);
              }}
            />
          ) : (
            <Text variant="caption">{t("unavailable")}</Text>
          )}
        </View>
      )}
    </>
  );
};
