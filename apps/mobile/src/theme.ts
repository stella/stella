import { useColorScheme } from "react-native";

const lightColors = {
  accent: "#335cff",
  background: "#f7f7f5",
  border: "#deded8",
  card: "#ffffff",
  muted: "#676761",
  text: "#171715",
} as const;

const darkColors = {
  accent: "#92a7ff",
  background: "#11110f",
  border: "#363631",
  card: "#1b1b18",
  muted: "#a4a49d",
  text: "#f4f4ef",
} as const;

export const useAppColors = () =>
  useColorScheme() === "dark" ? darkColors : lightColors;
