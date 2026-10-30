import { useColorScheme } from "react-native";

import { UI_COLORS } from "@/ui-theme.gen";
import type { UiColors } from "@/ui-theme.gen";

/**
 * The app's colours, named for what they paint. Each one is a token of the
 * web theme (`ui-theme.gen.ts`, generated from `@stll/ui`), so the app and
 * the web show the same colours and change together.
 */
const appColors = (ui: UiColors) =>
  ({
    accent: ui.primary,
    background: ui.background,
    border: ui.border,
    card: ui.card,
    muted: ui.mutedForeground,
    onAccent: ui.primaryForeground,
    text: ui.foreground,
  }) as const;

const LIGHT = appColors(UI_COLORS.light);
const DARK = appColors(UI_COLORS.dark);

export const useAppColors = () => (useColorScheme() === "dark" ? DARK : LIGHT);

/** Every web token for the current colour scheme, for props a class cannot reach. */
export const useUiColors = (): UiColors =>
  useColorScheme() === "dark" ? UI_COLORS.dark : UI_COLORS.light;
