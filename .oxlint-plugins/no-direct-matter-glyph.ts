// The matter (layers) glyph must never be rendered without a matter
// colour. `<MatterIcon>` (apps/web/src/components/matter-icon.tsx) is the
// only sanctioned way to draw it: its `matter` arm always resolves a
// colour through `resolveMatterColor`, and its `variant` arm paints the
// deliberate muted neutral treatment. To make an uncoloured matter glyph
// structurally impossible, ban the raw `LayersIcon` (and `Layers`) import
// from `lucide-react` everywhere except that one component.

import { getImportedName } from "./utils.ts";

const LUCIDE_MODULE = "lucide-react";

// lucide exports both the plain and `Icon`-suffixed aliases of the glyph,
// plus the `Layers2` stacked variant used for the "all matters" look.
const BANNED_IMPORTS = new Set([
  "Layers",
  "LayersIcon",
  "Layers2",
  "Layers2Icon",
]);

// The single file allowed to import the raw glyph.
const ALLOWED_FILE = "apps/web/src/components/matter-icon.tsx";

const filenameForContext = (context) =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

export default {
  meta: { name: "no-direct-matter-glyph" },
  rules: {
    "no-direct-matter-glyph": {
      meta: {
        type: "problem",
        messages: {
          directMatterGlyph:
            "Do not import '{{name}}' from 'lucide-react' here. Render " +
            "<MatterIcon> from '@/components/matter-icon' instead so the " +
            "matter colour is always applied (matter={{ id, color }}, or " +
            'variant="none" / variant="all" for non-matter affordances). ' +
            "The raw glyph is only allowed in matter-icon.tsx.",
        },
      },
      create(context) {
        if (filenameForContext(context).endsWith(ALLOWED_FILE)) {
          return {};
        }

        return {
          ImportDeclaration(node) {
            if (node.source?.value !== LUCIDE_MODULE) {
              return;
            }
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const name = getImportedName(specifier);
              if (name !== null && BANNED_IMPORTS.has(name)) {
                context.report({
                  node: specifier,
                  messageId: "directMatterGlyph",
                  data: { name },
                });
              }
            }
          },
        };
      },
    },
  },
};
