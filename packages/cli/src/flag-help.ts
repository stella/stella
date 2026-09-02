// Shared `FlagSpec` -> help-text derivation. The runtime `--help` output
// (`build-cli-tree.ts`) and the generated `SKILL.md` (`generate-skill.ts`)
// both render a flag's help line through these functions, so the flags an
// agent reads in the skill can never drift from what `--help` actually
// prints for the same command.

import type { FlagSpec } from "./route-types.js";

const flagKindFact = (spec: FlagSpec): string => {
  if (spec.enum) {
    return `${spec.kind}: ${spec.enum.join(", ")}`;
  }
  if (spec.min !== undefined || spec.max !== undefined) {
    return `${spec.kind} ${spec.min ?? "-inf"}..${spec.max ?? "inf"}`;
  }
  return spec.kind;
};

/**
 * The schema facts as one parenthesised, comma-separated clause:
 * `(required, string)`, `(optional, enum: draft, sent)`, `(optional, int
 * 1..100, repeatable)`. Required-ness is a fact about the tool input, not
 * about the underlying stricli flag, which stays optional at the parser layer
 * (every field can also arrive through `--input`).
 */
export const mechanicalFlagFacts = (spec: FlagSpec): string => {
  const parts = [spec.required ? "required" : "optional", flagKindFact(spec)];
  if (spec.repeatable) {
    parts.push("repeatable");
  }
  return `(${parts.join(", ")})`;
};

/**
 * A flag's `--help` line: the property's authored prose first (that is what a
 * caller — usually an agent — actually needs), then the mechanical
 * required/kind/enum/range facts the schema already encodes.
 */
export const flagBrief = (spec: FlagSpec): string => {
  const facts = mechanicalFlagFacts(spec);
  return spec.description === undefined
    ? facts
    : `${spec.description} ${facts}`;
};
