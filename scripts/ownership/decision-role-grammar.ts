import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "decision-role-grammar",
  capability:
    "Reading a decision's parts by its language's words: the ruling's operative verbs, the reasons heading, the recital, the closing and the signatures",
  owner: [
    "packages/legal-ast/src/czech-document-roles.ts",
    "packages/legal-ast/src/slovak-document-roles.ts",
    "packages/legal-ast/src/polish-document-roles.ts",
    "packages/legal-ast/src/separate-opinion-heading.ts",
    "packages/legal-ast/src/decision-role-grammar.ts",
  ],
  summary:
    "One grammar per language, read on letter-spacing-collapsed text, which " +
    "every parser of that language calls, so a bench signing under its " +
    "ruling or a spaced reasons heading reads the same in every source. " +
    "A role rule written inside a parser imports nothing a lint rule could " +
    "confine; the structure-fidelity guard reads every source's fixtures " +
    "through the same grammar for a signature read as the ruling and a " +
    "ruling after the reasons heading.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
