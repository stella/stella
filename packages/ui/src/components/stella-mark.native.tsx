import Svg, { Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";

import { STELLA_MARK } from "./stella-mark.shared";

const BOX = STELLA_MARK.viewBox.split(" ").map(Number);
const WIDTH = BOX[2] ?? 1;
const HEIGHT = BOX[3] ?? 1;

/**
 * The web's `StellaMark` (./stella-mark.tsx) on a phone: the same paths, in
 * the foreground colour, `size` points tall. Decorative, like the web's.
 */
export const StellaMark = ({ size = 28 }: { size?: number | undefined }) => {
  const foreground = useCSSVariable("--color-foreground");
  return (
    <Svg
      accessibilityElementsHidden
      height={size}
      importantForAccessibility="no-hide-descendants"
      viewBox={STELLA_MARK.viewBox}
      width={(size * WIDTH) / HEIGHT}
    >
      {STELLA_MARK.paths.map((d) => (
        <Path
          d={d}
          fill={typeof foreground === "string" ? foreground : "currentColor"}
          key={d}
        />
      ))}
    </Svg>
  );
};
