/* oxlint-disable unicorn/prefer-module -- fixture: require is one of the import forms under test */

// Passive regression fixture for
// `no-direct-lucide-import/no-direct-lucide-import`.
//
// lucide-react is imported only by the shared icon module,
// packages/ui/src/icons.ts; everything else goes through `@stll/ui/icons`.

// oxlint-disable-next-line no-direct-lucide-import/no-direct-lucide-import -- a named import
import { BookOpenIcon } from "lucide-react";
// oxlint-disable-next-line no-direct-lucide-import/no-direct-lucide-import -- a type-only import
import type { LucideIcon } from "lucide-react";

// expect-clean: no-direct-lucide-import/no-direct-lucide-import
import { SkillIcon } from "@stll/ui/icons";

// oxlint-disable-next-line no-direct-lucide-import/no-direct-lucide-import -- a dynamic import
const { BookOpenIcon: LoadedGlyph } = await import("lucide-react");
// oxlint-disable-next-line no-direct-lucide-import/no-direct-lucide-import -- require
const RequiredGlyph = require("lucide-react").BookOpenIcon;

// oxlint-disable-next-line no-direct-lucide-import/no-direct-lucide-import -- a re-export
export { WandSparklesIcon } from "lucide-react";

const Book: LucideIcon = BookOpenIcon;

export const DirectLucideImportFixture = () => (
  <>
    <Book />
    <SkillIcon />
    <LoadedGlyph />
    <RequiredGlyph />
  </>
);
