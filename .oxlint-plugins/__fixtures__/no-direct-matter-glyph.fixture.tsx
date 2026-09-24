/* oxlint-disable import/no-duplicates, no-duplicate-imports, unicorn/prefer-module, import/namespace, typescript/dot-notation -- fixture: each import form stands on its own line */

// Passive regression fixture for
// `no-direct-matter-glyph/no-direct-matter-glyph`.
//
// The raw matter (layers) glyph is restricted to
// apps/web/src/components/matter-icon.tsx in every lucide spelling (`X`,
// `XIcon`, `LucideX`) and every way of reaching it.

// expect-clean: no-direct-matter-glyph/no-direct-matter-glyph
import * as Lucide from "lucide-react";
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- x2: one per imported glyph
import { Layers2Icon, LayersIcon as MatterGlyph } from "lucide-react";
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- prefixed spelling
import { LucideLayers } from "lucide-react";
// expect-clean: no-direct-matter-glyph/no-direct-matter-glyph
import { FileIcon } from "lucide-react";

// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- namespace member
const NamespaceGlyph = Lucide.Layers;
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- computed member
const ComputedGlyph = Lucide["Layers2"];
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- destructured from the namespace
const { LayersIcon: DestructuredGlyph } = Lucide;
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- require member
const RequiredGlyph = require("lucide-react").LayersIcon;
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- awaited dynamic import with destructuring
const { Layers2: LoadedGlyph } = await import("lucide-react");
// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- member of an awaited dynamic import
const AwaitedGlyph = (await import("lucide-react")).LucideLayers2;
// expect-clean: no-direct-matter-glyph/no-direct-matter-glyph
const NeutralGlyph = Lucide.FileTextIcon;

// oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- named re-export
export { LayersIcon as ReexportedGlyph } from "lucide-react";

export const DirectMatterGlyphFixture = () => (
  <>
    <MatterGlyph />
    <Layers2Icon />
    <LucideLayers />
    <FileIcon />
    <NamespaceGlyph />
    <ComputedGlyph />
    <DestructuredGlyph />
    <RequiredGlyph />
    <LoadedGlyph />
    <AwaitedGlyph />
    <NeutralGlyph />
    {/* oxlint-disable-next-line no-direct-matter-glyph/no-direct-matter-glyph -- namespace member in JSX */}
    <Lucide.LayersIcon />
    {/* expect-clean: no-direct-matter-glyph/no-direct-matter-glyph */}
    <Lucide.FileIcon />
  </>
);
