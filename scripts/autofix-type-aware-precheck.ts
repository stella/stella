import { readFileSync } from "node:fs";

import {
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
// Autofix prepares the generated type graph only when a type-aware safe rule
// could report a changed file. Each type-aware safe rule names a syntax-only
// superset of what it reports: type information may only add exceptions. A
// file that cannot be read or parsed fails the scan, which takes the full path.
// scripts/autofix-type-aware.test.ts requires an entry for every type-aware
// rule in scripts/autofix-safe-rules.ts and checks each against oxlint.
type TypeAwareCandidate = (node: Node) => boolean;

// dot-notation reports `object["name"]` and `object[`name`]` only; its options
// and the types it reads only exempt some of those accesses.
const literalKeyMemberAccess: TypeAwareCandidate = (node) =>
  node.type === "MemberExpression" &&
  node.computed &&
  ((node.property.type === "Literal" &&
    typeof node.property.value === "string") ||
    (node.property.type === "TemplateLiteral" &&
      node.property.expressions.length === 0));

export const TYPE_AWARE_SAFE_RULE_CANDIDATES = {
  "typescript/dot-notation": literalKeyMemberAccess,
} as const satisfies Readonly<Record<string, TypeAwareCandidate>>;

const candidates = Object.values(TYPE_AWARE_SAFE_RULE_CANDIDATES);

/** Whether any type-aware safe rule could report this source. */
export const hasTypeAwareCandidate = (fileName: string, sourceText: string) => {
  let found = false;
  walk(parseSource(fileName, sourceText).program, (node) => {
    if (found || candidates.some((candidate) => candidate(node))) {
      found = true;
      return "skip-children";
    }
    return undefined;
  });
  return found;
};

// Exit 0: no changed file has a candidate, so the type-aware fixer has nothing
// to fix. Exit 1 lists the files that do; any other failure exits non-zero.
if (import.meta.main) {
  const flagged = process.argv
    .slice(2)
    .filter((file) => hasTypeAwareCandidate(file, readFileSync(file, "utf-8")));
  for (const file of flagged) {
    console.log(`Type-aware autofix candidate: ${file}`);
  }
  process.exit(flagged.length > 0 ? 1 : 0);
}
