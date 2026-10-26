import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "reference-peek",
  capability:
    "Previewing a cited decision, provision, act or unresolved citation on hover, focus or press",
  owner: [
    "packages/decision-reader/src/reference-peek.tsx",
    "packages/decision-reader/src/reference-peek.logic.ts",
    "packages/decision-reader/src/reference-peek-layering.ts",
  ],
  summary:
    "`ReferencePeek` is the one shell every reference peek uses: one open " +
    "and close delay, one header (kind icon, identifier, facts, actions), " +
    "one bounded body and one action set, decided per kind by the total " +
    "`REFERENCE_PEEK_KINDS` map. Kinds pass their content as the body. The " +
    "selection toolbar holds every peek closed while it is on screen; the " +
    "hold is taken only by `SelectionToolbar`, so the layering rule lives " +
    "in one place.",
  enforcement: {
    kind: "import",
    specifiers: ["@stll/decision-reader/reference-peek-layering"],
    allowed: [
      {
        path: "apps/web/src/components/selection-toolbar.tsx",
        reason:
          "The floating bar over selected text holds peeks while mounted.",
      },
      {
        path: "apps/web/src/components/legal-reader/reference-peek.dom.test.tsx",
        reason: "Holds peeks directly to cover the layering rule.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
