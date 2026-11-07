import { StyleSheet, useColorScheme } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import {
  AUTH_GRADIENT_END,
  AUTH_GRADIENT_START,
} from "@/components/auth-backdrop";
import { useAppColors } from "@/theme";

/** The web sign-in's backdrop: the background, turning blue toward the foot. */
export const AuthBackdrop = () => {
  const colors = useAppColors();
  const end =
    useColorScheme() === "dark"
      ? AUTH_GRADIENT_END.dark
      : AUTH_GRADIENT_END.light;
  return (
    <Svg pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="auth-backdrop" x1="0" x2="0" y1="0" y2="1">
          <Stop offset={AUTH_GRADIENT_START} stopColor={colors.background} />
          <Stop offset={1} stopColor={end} />
        </LinearGradient>
      </Defs>
      <Rect fill="url(#auth-backdrop)" height="100%" width="100%" />
    </Svg>
  );
};
