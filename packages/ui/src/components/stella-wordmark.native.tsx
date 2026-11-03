import Svg, { Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";

import { STELLA_WORDMARK } from "./stella-wordmark.shared";

const BOX = STELLA_WORDMARK.viewBox.split(" ").map(Number);
const WIDTH = BOX[2] ?? 1;
const HEIGHT = BOX[3] ?? 1;

/**
 * The web's `StellaWordmarkLatin` (./stella-wordmark.tsx) on a phone: the
 * same paths, in the foreground colour, `height` points tall.
 */
export const StellaWordmarkLatin = ({
  height = 20,
}: {
  height?: number | undefined;
}) => {
  const foreground = useCSSVariable("--color-foreground");
  return (
    <Svg
      accessibilityLabel="stella"
      height={height}
      viewBox={STELLA_WORDMARK.viewBox}
      width={(height * WIDTH) / HEIGHT}
    >
      {STELLA_WORDMARK.paths.map((d) => (
        <Path
          d={d}
          fill={typeof foreground === "string" ? foreground : "currentColor"}
          key={d}
        />
      ))}
    </Svg>
  );
};
