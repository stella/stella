// Scales of justice and gavels are the stock iconography of legal software.
// They are decorative rather than informative: every product in the category
// draws them, none of Stella's surfaces need them, and a lawyer reading a
// results table learns nothing from a pair of scales above it. This design
// system draws the concept instead of the cliché.
//
// Replacements, by what the glyph actually stands for:
//   court            -> LandmarkIcon
//   decision/opinion -> FileTextIcon, or BookOpenIcon for a collection
//   the case-law section -> the glyph the sidebar's law entry already uses
//
// Flagged, each at its own site so the replacement decision is reported where
// it has to be made:
//   import { Scale as JusticeIcon } from "lucide-react";
//   <GavelIcon />
//   <Icon as={ScaleIcon} />
//
// Allowed:
//   any other lucide glyph, including the `Scale3d` family (a geometry
//   transform, not a balance) and a local component named `Scale`.
//
// The bindings resolve through their `lucide-react` import, so a same-named
// local component or a re-export from elsewhere is out of scope. `Hammer` and
// `Weight` are not in the set: lucide draws them as a tool and a gym plate,
// and neither reads as a gavel or a balance.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

import {
  getImportLocalName,
  getImportedName,
  isAstNode,
  isIdentifier,
  jsxName,
} from "./utils.ts";

const LUCIDE_MODULE = "lucide-react";

// lucide exports the plain, `Icon`-suffixed and `Lucide`-prefixed alias of
// every glyph, and each is a separate named export a caller can reach for.
const BANNED_IMPORTS = new Set([
  "Gavel",
  "GavelIcon",
  "LucideGavel",
  "LucideScale",
  "Scale",
  "ScaleIcon",
]);

/**
 * Whether this identifier stands for the binding itself rather than naming
 * something else that happens to share its spelling: a member property, an
 * object key, or the import specifier already reported.
 */
const isValueReference = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (parent.type === "ImportSpecifier") {
    return false;
  }
  if (parent.type === "MemberExpression" && parent.computed === false) {
    return parent.property !== node;
  }
  if (parent.type === "Property" && parent.computed === false) {
    return parent.key !== node;
  }
  return true;
};

export default eslintCompatPlugin({
  meta: { name: "no-legal-cliche-glyph" },
  rules: {
    "no-legal-cliche-glyph": {
      meta: {
        type: "problem",
        messages: {
          legalClicheGlyph:
            "Do not draw '{{name}}' from 'lucide-react'. Scales-of-justice " +
            "and gavel glyphs are legal cliché: overdrawn across the " +
            "category, and this design system does not use them. Name the " +
            "concept instead — a court is <LandmarkIcon>, a decision is " +
            "<FileTextIcon> (<BookOpenIcon> for a collection of them), and " +
            "the case-law section takes the glyph its sidebar entry already " +
            "uses.",
        },
      },
      createOnce(context) {
        const bannedLocals = new Map<string, string>();

        const report = (node: Ranged, name: string) => {
          context.report({
            node,
            messageId: "legalClicheGlyph",
            data: { name },
          });
        };

        return {
          Program(program) {
            bannedLocals.clear();
            if (!isAstNode(program) || !Array.isArray(program.body)) {
              return;
            }
            for (const statement of program.body) {
              if (
                !isAstNode(statement) ||
                statement.type !== "ImportDeclaration" ||
                !isAstNode(statement.source) ||
                statement.source.value !== LUCIDE_MODULE ||
                !Array.isArray(statement.specifiers)
              ) {
                continue;
              }
              for (const specifier of statement.specifiers) {
                const imported = getImportedName(specifier);
                const local = getImportLocalName(specifier);
                if (imported === null || local === null) {
                  continue;
                }
                if (BANNED_IMPORTS.has(imported)) {
                  bannedLocals.set(local, imported);
                }
              }
            }
          },
          ImportDeclaration(node) {
            if (node.source.value !== LUCIDE_MODULE) {
              return;
            }
            if (!Array.isArray(node.specifiers)) {
              return;
            }
            for (const specifier of node.specifiers) {
              const imported = getImportedName(specifier);
              if (imported !== null && BANNED_IMPORTS.has(imported)) {
                report(specifier, imported);
              }
            }
          },
          JSXOpeningElement(node) {
            const name = jsxName(node.name);
            const imported = name === null ? undefined : bannedLocals.get(name);
            if (imported !== undefined) {
              report(node.name, imported);
            }
          },
          Identifier(node) {
            if (!isIdentifier(node)) {
              return;
            }
            const imported = bannedLocals.get(node.name);
            if (imported !== undefined && isValueReference(node)) {
              report(node, imported);
            }
          },
        };
      },
    },
  },
});
