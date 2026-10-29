import { NativeTabs } from "expo-router/native-tabs";
import { useTranslations } from "use-intl";

import { BAR_GLYPHS } from "@/bar-glyphs.gen";
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
        <NativeTabs.Trigger.Icon xcasset={BAR_GLYPHS["message-square"]} />
        <NativeTabs.Trigger.Label>{t("chat")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon xcasset={BAR_GLYPHS["list-todo"]} />
        <NativeTabs.Trigger.Label>{t("tasks")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="matters">
        <NativeTabs.Trigger.Icon xcasset={BAR_GLYPHS.layers} />
        <NativeTabs.Trigger.Label>{t("matters")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Icon xcasset={BAR_GLYPHS["grid-2x2-plus"]} />
        <NativeTabs.Trigger.Label>{t("more")}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
};

export default TabLayout;
