import { DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";

const lightColors = {
  accent: "#335cff",
  background: "#f7f7f5",
  border: "#deded8",
  card: "#ffffff",
  danger: "#c91c1c",
  muted: "#676761",
  text: "#171715",
} as const;

const darkColors = {
  accent: "#92a7ff",
  background: "#11110f",
  border: "#363631",
  card: "#1b1b18",
  danger: "#ff7b72",
  muted: "#a4a49d",
  text: "#f4f4ef",
} as const;

export const useAppColors = () =>
  useColorScheme() === "dark" ? darkColors : lightColors;

export const useAppNavigationTheme = () => {
  const isDark = useColorScheme() === "dark";
  const colors = isDark ? darkColors : lightColors;
  const baseTheme = isDark ? DarkTheme : DefaultTheme;

  return {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      background: colors.background,
      border: colors.border,
      card: colors.card,
      notification: colors.danger,
      primary: colors.accent,
      text: colors.text,
    },
  };
};
