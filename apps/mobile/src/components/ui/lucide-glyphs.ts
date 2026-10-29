import createIconSet from "@expo/vector-icons/createIconSet";
import codepoints from "lucide-static/font/codepoints.json";
import lucideFont from "lucide-static/font/lucide.ttf";

/**
 * lucide, the web's icon set, as a font: the same glyphs as `icons.gen.ts`
 * (the catalog pins lucide-static to the web's lucide version), drawn by
 * name, as More's rows draw theirs. The platform's own bars take asset
 * catalog images of the same outlines instead (`bar-glyphs.gen.ts`).
 */
export const LucideGlyphs = createIconSet(codepoints, "lucide", lucideFont);
