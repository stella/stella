import type { ComponentProps } from "react";

import { SafeAreaView as PlatformSafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

/**
 * Uniwind reads `className` only on React Native's own components; a
 * library's view drops it unless wrapped, so a screen laid out with classes
 * lost its layout and background.
 */
const StyledSafeAreaView = withUniwind(PlatformSafeAreaView);

/** A screen inside the safe area, filling it with the app's background. */
export const SafeAreaView = (
  props: Omit<ComponentProps<typeof StyledSafeAreaView>, "className">,
) => <StyledSafeAreaView {...props} className="bg-background flex-1" />;
