import { useTransition } from "react";

import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { ScreenHeading, screenStyles } from "@/components/empty-state-screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSession } from "@/connection/session-provider";

const SettingsScreen = () => {
  const t = useTranslations();
  const { signOut, state } = useSession();
  const [pending, startTransition] = useTransition();
  const serverUrl =
    state.status === "signed-in" ? state.source.session().serverUrl : null;

  return (
    <SafeAreaView className="bg-background flex-1" edges={["top"]}>
      <ScrollView contentContainerStyle={screenStyles.content}>
        <ScreenHeading title={t("tabs.settings")} />
        <View className="gap-2">
          <View className="px-1">
            <Text accessibilityRole="header" variant="section">
              {t("settings.accountTitle")}
            </Text>
          </View>
          <View className="border-border bg-card gap-1 rounded-xl border p-4">
            <Text variant="caption">{t("settings.server")}</Text>
            <Text selectable>{serverUrl}</Text>
          </View>
        </View>
        <Button
          disabled={pending}
          label={t("settings.signOut")}
          loading={pending}
          onPress={() => {
            startTransition(async () => {
              await signOut();
            });
          }}
          variant="destructive-outline"
        />
      </ScrollView>
    </SafeAreaView>
  );
};

export default SettingsScreen;
