// Bans a dynamic string as the replacement (second) argument of
// `String.prototype.replace()`/`replaceAll()`.
//
// JS interprets special replacement patterns (`$&`, `$$`, `` $` ``, `$'`,
// `$<n>`/`$<name>`) inside the replacement string even when the search
// argument is a plain string, not a regex. A caller who builds the
// replacement dynamically (user input, a DB value, a concatenated/templated
// string) has no reason to expect that syntax to be interpreted, so a `$`
// landing in the dynamic value silently corrupts the output instead of
// being inserted literally. A function replacer is immune: its return
// value is inserted verbatim, with no pattern substitution.
//
// Flags any `.replace(...)`/`.replaceAll(...)` call with exactly two
// arguments whose second argument is not one of:
//   (a) an inline arrow/function expression — return value is used as-is;
//   (b) a string literal or no-substitution template literal — `$`
//       sequences are then author-visible in the source and presumed
//       intentional;
//   (c) an identifier that resolves, through the scope API, to a function
//       declaration or a `const`/`let` arrow/function-expression
//       assignment. Any other resolution (parameter, import, class name,
//       catch binding, unresolved) is reported, since a purely syntactic
//       check cannot prove the binding is a function.
//
// Flags:
//   text.replace(pattern, dynamicValue)
//   text.replace(pattern, `prefix-${dynamicValue}`)
//   text.replace(pattern, getReplacement())
//   text.replace(pattern, cond ? a : b)
//   text.replaceAll(pattern, someObject.field)
//   const label = computeLabel(); text.replace(pattern, label);
//
// Allows:
//   text.replace(pattern, () => dynamicValue)
//   text.replace(pattern, "literal")
//   text.replace(pattern, `literal`)
//   text.replace(pattern, (match) => match.toUpperCase())
//   function toReplacement(match) { return match; }
//   text.replace(pattern, toReplacement);
//   const toReplacement = (match) => match;
//   text.replace(pattern, toReplacement);
//
// Scope: only `context.sourceCode.getScope` + `Scope.set`, walking `.upper`
// (mirrors require-eden-error-check.ts) is used to resolve identifiers —
// no type information. This is why an identifier bound via `import`,
// destructuring, or aliasing to another function-valued binding is not
// resolved as "provably a function" and gets reported; wrap it in an arrow
// (`.replace(pattern, () => importedFn(match))`) or a local
// `const`/function declaration to satisfy the rule.
//
// Known limits:
// - Purely syntactic: reassignment after a function-valued `let`
//   declaration is not tracked, so `let f = () => x; f = "$&";
//   text.replace(p, f);` is allowed even though `f` is no longer a
//   function at the call site. Repo-wide grep at authoring time found no
//   such reassignment pattern.
// - Only calls with exactly two non-spread arguments are checked, so a
//   spread call (`text.replace(...args)`) or a single-argument call is
//   skipped. `.replace`/`.replaceAll` are matched by property name alone
//   (computed or not).
// - One confirmed non-string two-argument `replace` exists in the repo's
//   dependencies: Bun's `HTMLRewriter` `Element`/`Comment`/`Text.replace
//   (content, options?: { html?: boolean })` (see
//   apps/api/src/lib/markdown/ai-tool.ts). `String.prototype.replace`/
//   `replaceAll` never take a plain object as their second argument, so a
//   second argument that is an object expression (`{ ... }`) is skipped
//   outright — not reported, not required to be a function — rather than
//   trying to allowlist every such API by callee name. If a future non-
//   string `replace(pattern, value)` method takes a non-object second
//   argument, add a callee-name/type exclusion here.

import { isIdentifier, isStringLiteral, unwrapExpression } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

const REPLACE_METHODS = new Set(["replace", "replaceAll"]);

// Resolve the static name of a (possibly computed) MemberExpression
// property, the same way the reference rule's callee checks do: an
// Identifier's name, or a string Literal's value.
const getStaticPropertyName = (node: unknown): string | null => {
  if (isIdentifier(node)) {
    return node.name;
  }
  if (isStringLiteral(node)) {
    return node.value;
  }
  return null;
};

const isFunctionExpressionLike = (node: unknown): boolean =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression");

// A no-substitution template literal (`` `plain text` ``, no `${...}`
// interpolation): its contents are as author-visible and static as a
// string literal, so `$&`-style sequences in it are presumed intentional.
const isNoSubstitutionTemplateLiteral = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "TemplateLiteral" &&
  Array.isArray(node.expressions) &&
  node.expressions.length === 0;

export default {
  meta: { name: "require-function-replacer" },
  rules: {
    "require-function-replacer": {
      meta: {
        type: "problem",
        messages: {
          requireFunctionReplacer:
            "Dynamic value passed as the replacement argument of " +
            "'.{{method}}()'. JS interprets '$&', '$$', \"$`\", \"$'\", " +
            "and '$<name>' in replacement strings even for a plain-string " +
            "search, so dynamic content can silently corrupt the output. " +
            "Wrap the replacement in a function: " +
            ".{{method}}(pattern, () => value).",
        },
      },
      create(context) {
        // Resolve the `Variable` an Identifier reference binds to by
        // walking the scope chain outward from its use site (mirrors
        // require-eden-error-check.ts's resolveVariable — this plugin API
        // has no ready-made `findVariable` helper of its own).
        const resolveVariable = (
          identifierNode: AstNode & { name: string },
        ) => {
          let scope = context.sourceCode.getScope(identifierNode);
          while (scope) {
            const variable = scope.set.get(identifierNode.name);
            if (variable) {
              return variable;
            }
            scope = scope.upper;
          }
          return null;
        };

        // True when `identifierNode` resolves, through scope, to a
        // function declaration (`function foo() {}`) or a `const`/`let`
        // variable whose own initializer is an arrow/function expression.
        // Any other resolution (`var`, parameter, import binding, class
        // name, catch binding, or unresolved) is not provably a function
        // from syntax alone and returns false.
        const isFunctionBinding = (
          identifierNode: AstNode & { name: string },
        ): boolean => {
          const variable = resolveVariable(identifierNode);
          if (variable === null) {
            return false;
          }
          return variable.defs.some((def) => {
            if (def.type === "FunctionName") {
              return (
                isAstNode(def.node) && def.node.type === "FunctionDeclaration"
              );
            }
            if (def.type !== "Variable" || !isAstNode(def.node)) {
              return false;
            }
            if (def.node.type !== "VariableDeclarator") {
              return false;
            }
            if (
              !isAstNode(def.parent) ||
              def.parent.type !== "VariableDeclaration" ||
              def.parent.kind === "var"
            ) {
              return false;
            }
            return isFunctionExpressionLike(unwrapExpression(def.node.init));
          });
        };

        // True when `argument` (already unwrapped of TS wrapping) is an
        // allowed replacement value under the rule's three branches.
        const isAllowedReplacement = (argument: unknown): boolean => {
          if (isFunctionExpressionLike(argument)) {
            return true;
          }
          if (isStringLiteral(argument)) {
            return true;
          }
          if (isNoSubstitutionTemplateLiteral(argument)) {
            return true;
          }
          if (isIdentifier(argument)) {
            return isFunctionBinding(argument);
          }
          return false;
        };

        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (!isAstNode(callee) || callee.type !== "MemberExpression") {
              return;
            }

            const method = getStaticPropertyName(callee.property);
            if (method === null || !REPLACE_METHODS.has(method)) {
              return;
            }

            if (node.arguments.length !== 2) {
              return;
            }
            const [pattern, replacement] = node.arguments;
            if (
              !isAstNode(pattern) ||
              pattern.type === "SpreadElement" ||
              !isAstNode(replacement) ||
              replacement.type === "SpreadElement"
            ) {
              return;
            }

            const unwrappedReplacement = unwrapExpression(replacement);

            // `String.prototype.replace`/`replaceAll` never take a plain
            // object as their second argument, so an object-expression
            // second argument means this is not a String.replace call at
            // all (e.g. Bun's `HTMLRewriter` `Element.replace(content,
            // { html })`) — skip rather than report or require a function.
            if (
              isAstNode(unwrappedReplacement) &&
              unwrappedReplacement.type === "ObjectExpression"
            ) {
              return;
            }

            if (isAllowedReplacement(unwrappedReplacement)) {
              return;
            }

            context.report({
              node: replacement,
              messageId: "requireFunctionReplacer",
              data: { method },
            });
          },
        };
      },
    },
  },
};
