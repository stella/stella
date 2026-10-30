import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { useTranslations } from "use-intl";

import { BAR_GLYPHS } from "@/bar-glyphs.gen";
import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { useAppColors } from "@/theme";

/**
 * The platform's own tab bar (iOS's, with its glass), each tab drawn with the
 * web navigation's glyph (apps/web workspace-primary-nav.ts) from lucide:
 * chat's bubble, tasks' list and the matters layers. More is the bar's
 * prominent tab, which iOS 27 draws apart on its own surface; it holds case
 * law, settings and what is still to come. On an iPad the bar can open
 * into a sidebar, as the system's own apps and GitHub's do.
 * `tab-icons.test.ts` holds them equal. The glyphs are asset catalog images
 * (`bar-glyphs.gen.ts`), which the bar loads by name as it is built, so no
 * tab stands bare while its glyph is drawn.
 */
const TabLayout = () => {
  const colors = useAppColors();
  const t = useTranslations("tabs");

  return (
    <NativeTabs
      iconColor={{ default: colors.muted, selected: colors.text }}
      sidebarAdaptable
      tintColor={colors.text}
      // iOS 27 sets the prominent tab apart from the bar on its own surface.
      unstable_nativeProps={{ ios: { prominentScreenKey: "more" } }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon {...tabIcon("message-square")} />
        <NativeTabs.Trigger.Label>{t("chat")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon {...tabIcon("list-todo")} />
        <NativeTabs.Trigger.Label>{t("tasks")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matters">
        <NativeTabs.Trigger.Icon {...tabIcon("layers")} />
        <NativeTabs.Trigger.Label>{t("matters")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Icon {...tabIcon("grid-2x2-plus")} />
        <NativeTabs.Trigger.Label>{t("more")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
};

/**
 * A tab's glyph: on iOS the asset catalog image, which the bar loads as it is
 * built; elsewhere, which has no asset catalog, lucide's font draws it.
 */
const tabIcon = (glyph: keyof typeof BAR_GLYPHS) =>
  Platform.OS === "ios"
    ? { xcasset: BAR_GLYPHS[glyph] }
    : {
        src: (
          <NativeTabs.Trigger.VectorIcon family={LucideGlyphs} name={glyph} />
        ),
      };

export default TabLayout;
