// Only these rules may rewrite PR source. Adding a rule requires reviewing its
// safe fixer; CI still reports every rule outside this list.
export const SAFE_AUTOFIX_RULES = {
  "eslint/curly": "Adds braces without changing statement ownership.",
  "eslint/dot-notation":
    "Replaces constant string property access with the same identifier.",
  "eslint/no-extra-boolean-cast":
    "Removes redundant coercion only in boolean contexts.",
  "eslint/no-extra-label":
    "Removes a label only when the same target is implicit.",
  "eslint/no-regex-spaces":
    "Expresses repeated literal spaces with an equivalent quantifier.",
  "eslint/no-useless-computed-key":
    "Uses the same literal object key without brackets.",
  "eslint/no-useless-rename":
    "Removes identity import, export and destructuring aliases.",
  "eslint/no-useless-return":
    "Removes a final empty return with the same undefined result.",
  "eslint/prefer-numeric-literals":
    "Replaces literal parseInt calls with equivalent numeric literals.",
  "typescript/array-type": "Changes only erased array type spelling.",
  "typescript/prefer-as-const": "Uses an equivalent literal const assertion.",
} as const;

// Safe autofix rules must not include these type-aware fixers: preflight runs
// without a project type graph and must see every diagnostic the fixer can act on.
export const TYPE_AWARE_AUTOFIX_RULES = ["typescript/dot-notation"] as const;

export const safeAutofixRuleArgs = () => [
  "--allow",
  "all",
  ...Object.keys(SAFE_AUTOFIX_RULES).flatMap((rule) => ["--deny", rule]),
];

if (import.meta.main) {
  console.log(safeAutofixRuleArgs().join("\n"));
}
