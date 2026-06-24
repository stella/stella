// Require `escapeLike()` on interpolations in SQL LIKE / ILIKE patterns.
//
// Drizzle's `like` / `ilike` / `notLike` / `notIlike` parameterize the pattern
// value (so it is injection-safe), but they do NOT escape the LIKE
// metacharacters `%` and `_` inside it — in a LIKE pattern those are wildcards
// by design, so escaping user input is the caller's job. An un-escaped
// interpolation lets a typed `%` match every row and `_` match any character: a
// correctness bug and a mild DoS (full-table scans, with pagination disabled on
// the search path). The shared helper is `escapeLike()` from
// `@/api/lib/escape-like`.
//
// Flags — a LIKE pattern (inline, or a `const` resolved to a template literal)
// whose interpolation is not an `escapeLike(...)` call:
//   ilike(col, `%${q}%`)
//   const p = `%${q}%`;        like(col, p)
//   like(col, `${prefix}%`)    // wrap prefix in escapeLike (a no-op if safe)
//
// Allows:
//   ilike(col, `%${escapeLike(q)}%`)
//   like(col, `${escapeLike(base)}%${escapeLike(ext)}`)
//   ilike(col, pattern)        // opaque variable — cannot inspect
//   like(col, "literal")       // constant, no interpolation
//
// Escape hatch:
//   // oxlint-disable-next-line require-escape-like/require-escape-like
//   with a `// SAFETY:` note when the interpolation is provably wildcard-free.

import { isCallTo, isIdentifier, unwrapExpression } from "./utils.ts";

const LIKE_OPERATORS = new Set(["like", "ilike", "notLike", "notIlike"]);

const isTemplateLiteral = (node: unknown): boolean =>
  typeof node === "object" &&
  node !== null &&
  (node as { type?: unknown }).type === "TemplateLiteral";

// Whether any `${...}` in the pattern is not wrapped in `escapeLike(...)`.
const hasUnescapedInterpolation = (template: unknown): boolean => {
  const expressions = (template as { expressions?: unknown }).expressions;
  if (!Array.isArray(expressions)) {
    return false;
  }
  return expressions.some(
    (expression) => !isCallTo(unwrapExpression(expression), "escapeLike"),
  );
};

export default {
  meta: { name: "require-escape-like" },
  rules: {
    "require-escape-like": {
      meta: {
        type: "problem",
        messages: {
          unescaped:
            "Wrap interpolated values in this LIKE/ILIKE pattern with " +
            "`escapeLike()` (from @/api/lib/escape-like) so a typed `%` or `_` " +
            "matches literally instead of acting as a wildcard.",
        },
      },
      create(context) {
        // `const p = `…`;` inits, so `like(col, p)` resolves to the template
        // that built it. Declarations are visited before the call site.
        const templateConsts = new Map<string, unknown>();

        const resolvePattern = (pattern: unknown): unknown => {
          const unwrapped = unwrapExpression(pattern);
          if (isIdentifier(unwrapped)) {
            return templateConsts.get(unwrapped.name);
          }
          return unwrapped;
        };

        return {
          VariableDeclarator(node) {
            const id = (node as { id?: unknown }).id;
            const init = unwrapExpression((node as { init?: unknown }).init);
            if (isIdentifier(id) && isTemplateLiteral(init)) {
              templateConsts.set(id.name, init);
            }
          },
          CallExpression(node) {
            const callee = (node as { callee?: unknown }).callee;
            if (!(isIdentifier(callee) && LIKE_OPERATORS.has(callee.name))) {
              return;
            }
            const args = (node as { arguments?: unknown }).arguments;
            if (!Array.isArray(args) || args.length < 2) {
              return;
            }
            const pattern = resolvePattern(args[1]);
            if (
              pattern !== undefined &&
              isTemplateLiteral(pattern) &&
              hasUnescapedInterpolation(pattern)
            ) {
              context.report({ node, messageId: "unescaped" });
            }
          },
        };
      },
    },
  },
};
