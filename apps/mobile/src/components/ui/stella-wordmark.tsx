import Svg, { Path } from "react-native-svg";

import { STELLA_WORDMARK } from "@/brand.gen";
import { useAppColors } from "@/theme";

/** The stella wordmark, the web's paths (packages/ui stella-wordmark.tsx), in the foreground colour. */
export const StellaWordmark = ({ height = 20 }: { height?: number }) => {
  const colors = useAppColors();
  const box = STELLA_WORDMARK.viewBox.split(" ").map(Number);
  const width = box[2] ?? 1;
  const boxHeight = box[3] ?? 1;
  return (
    <Svg
      accessibilityLabel="stella"
      height={height}
      viewBox={STELLA_WORDMARK.viewBox}
      width={(height * width) / boxHeight}
    >
      {STELLA_WORDMARK.paths.map((d) => (
        <Path d={d} fill={colors.text} key={d} />
      ))}
    </Svg>
  );
};
