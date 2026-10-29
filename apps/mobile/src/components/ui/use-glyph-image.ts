import { useEffect, useState } from "react";

import type { ImageSourcePropType } from "react-native";

import { LucideGlyphs } from "@/components/ui/lucide-glyphs";
import { UI_COLORS } from "@/ui-theme.gen";

/**
 * A lucide glyph as an image, for the platform's own bar buttons, which take
 * an image rather than a component. Drawn in the foreground and tinted by the
 * bar, which keeps only its shape, so it follows the colour scheme. Null
 * until the glyph has been rendered.
 */
export const useGlyphImage = (
  name: Parameters<typeof LucideGlyphs.getImageSource>[0],
): ImageSourcePropType | null => {
  const [image, setImage] = useState<ImageSourcePropType | null>(null);
  useEffect(() => {
    let current = true;
    void LucideGlyphs.getImageSource(name, 22, UI_COLORS.light.foreground).then(
      (source) => {
        if (current) {
          setImage(source);
        }
        return undefined;
      },
    );
    return () => {
      current = false;
    };
  }, [name]);
  return image;
};
