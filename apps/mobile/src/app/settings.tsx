import { useTransition } from "react";

import * as WebBrowser from "expo-web-browser";
import { ScrollView, View } from "react-native";
import { useTranslations } from "use-intl";

import { screenStyles } from "@/components/empty-state-screen";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { accountPageUrl } from "@/connection/account-page";
import { useSession } from "@/connection/session-provider";

const SettingsScreen = () => {
  const t = useTranslations();
  const { signOut, state } = useSession();
  const [pending, startTransition] = useTransition();
  const session = state.status === "signed-in" ? state.source.session() : null;
  const serverUrl = session?.serverUrl ?? null;

  return (
    // The sheet's own bar carries the title and the close button.
    <ScrollView
      className="bg-background flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
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
      {session === null ? null : (
        <View className="gap-2">
          <Button
            label={t("settings.deleteAccount")}
            onPress={() => {
              void WebBrowser.openBrowserAsync(accountPageUrl(session.issuer));
            }}
            variant="outline"
          />
          <View className="px-1">
            <Text variant="caption">{t("settings.deleteAccountHint")}</Text>
          </View>
        </View>
      )}
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
  );
};

export default SettingsScreen;
