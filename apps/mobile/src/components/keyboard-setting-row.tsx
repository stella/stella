import { useRouter } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { keyboardDictationAvailable } from "@/native/keyboard-dictation";

/** Settings' way to the stella keyboard's setup; absent in a build without the keyboard. */
export const KeyboardSettingRow = () => {
  const t = useTranslations("keyboardDictation");
  const router = useRouter();
  return keyboardDictationAvailable() ? (
    <View className="gap-2">
      <Button
        onPress={() => {
          router.push("/keyboard/setup");
        }}
        variant="outline"
      >
        {t("title")}
      </Button>
      <View className="px-1">
        <Text variant="caption">{t("settingsHint")}</Text>
      </View>
    </View>
  ) : null;
};
