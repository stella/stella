import { Tabs } from "expo-router";
import { useTranslations } from "use-intl";

import { MattersNavIcon } from "@/components/ui/matter-icon";
import { CogIcon, ListTodoIcon, MessageSquareIcon } from "@/icons.gen";
import { useAppColors } from "@/theme";

/**
 * The app's sections, each drawn with the web navigation's glyph
 * (apps/web workspace-primary-nav.ts): chat's bubble, tasks' list, the
 * matters layers and settings' cog. `tab-icons.test.ts` holds them equal.
 */
const TabLayout = () => {
  const colors = useAppColors();
  const t = useTranslations("tabs");

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontFamily: "DMSans-Medium", fontSize: 11 },
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          tabBarIcon: ({ color }) => (
            <MessageSquareIcon color={color} size={22} />
          ),
          title: t("chat"),
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          tabBarIcon: ({ color }) => <ListTodoIcon color={color} size={22} />,
          title: t("tasks"),
        }}
      />
      <Tabs.Screen
        name="matters"
        options={{
          tabBarIcon: ({ color }) => <MattersNavIcon color={color} size={22} />,
          title: t("matters"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          tabBarIcon: ({ color }) => <CogIcon color={color} size={22} />,
          title: t("settings"),
        }}
      />
    </Tabs>
  );
};

export default TabLayout;
