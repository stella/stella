import { Tabs } from "expo-router";
import { useTranslations } from "use-intl";

import { useAppColors } from "@/theme";

const TabLayout = () => {
  const colors = useAppColors();
  const t = useTranslations("tabs");

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t("chat") }} />
      <Tabs.Screen name="tasks" options={{ title: t("tasks") }} />
      <Tabs.Screen name="matters" options={{ title: t("matters") }} />
      <Tabs.Screen name="settings" options={{ title: t("settings") }} />
    </Tabs>
  );
};

export default TabLayout;
