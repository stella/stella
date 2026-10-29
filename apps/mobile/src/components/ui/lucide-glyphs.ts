import createIconSet from "@expo/vector-icons/createIconSet";
import codepoints from "lucide-static/font/codepoints.json";
import lucideFont from "lucide-static/font/lucide.ttf";

/**
 * lucide, the web's icon set, as a font: the same glyphs as `icons.gen.ts`
 * (the catalog pins lucide-static to the web's lucide version), for the
 * places that take a glyph image rather than a component, such as the
 * platform's own tab bar.
 */
export const LucideGlyphs = createIconSet(codepoints, "lucide", lucideFont);
