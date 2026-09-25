// Suppression hygiene.
//
// Keeps lint/type suppression directives honest so the codebase does
// not re-accumulate undocumented or dead disables.
//
//   require-description — every `oxlint-disable` directive must
//     explain itself, either with an inline
//     `-- <reason>` trailer or a comment on the line directly above
//     (the `// SAFETY:` convention used for `as` casts). Catches bare
//     directives that silence a rule with no rationale.
//
//   no-foreign-directive — bans `biome-ignore` / `prettier-ignore`
//     comments. The toolchain is oxlint + oxfmt; biome is never run,
//     so its directives are dead, and oxfmt formatting belongs in the
//     code, not behind a prettier directive. Also bans the
//     `eslint-disable` / `eslint-enable` spelling: oxlint honours it as
//     an alias, but one directive with one spelling keeps every
//     suppression findable with a single search.
//
// `@ts-ignore` / `@ts-expect-error` hygiene is enforced separately by
// the native `typescript/ban-ts-comment` rule in oxlint.config.ts.
//
// Flagged:
//   // oxlint-disable-next-line no-console
//   /* oxlint-disable typescript/no-unnecessary-condition */
//   // biome-ignore lint/a11y/noStaticElementInteractions: ...
//   // eslint-disable-next-line no-console -- dev-only CLI output
// Allowed:
//   // oxlint-disable-next-line no-console -- dev-only CLI output
//   // SAFETY: url validated as http/https
//   // oxlint-disable-next-line typescript/no-unsafe-type-assertion

import { eslintCompatPlugin } from "@oxlint/plugins";

const DISABLE_RE = /\b(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/u;
const ENABLE_RE = /\b(?:eslint|oxlint)-enable\b/u;
const INLINE_DESCRIPTION_RE = /--\s*\S/u;
const FOREIGN_RE = /\b(?:biome-ignore|prettier-ignore)\b/u;
// Anchored at the comment start, where oxlint reads a directive, so prose
// that mentions the spelling mid-sentence stays allowed.
const LEGACY_SPELLING_RE = /^\s*(eslint-(?:disable|enable))\b/u;

const isComment = (value) =>
  typeof value === "object" &&
  value !== null &&
  typeof value.value === "string" &&
  typeof value.loc === "object" &&
  value.loc !== null;

const isDirective = (text) => DISABLE_RE.test(text) || ENABLE_RE.test(text);

const collectComments = (node) =>
  node && "comments" in node && Array.isArray(node.comments)
    ? node.comments.filter(isComment)
    : [];

export default eslintCompatPlugin({
  meta: { name: "suppression-hygiene" },
  rules: {
    "require-description": {
      meta: {
        type: "suggestion",
        messages: {
          requireDescription:
            "Suppression directive needs a reason: add a `-- <why>` trailer, " +
            "or a comment on the line directly above explaining why the rule " +
            "is suppressed here.",
        },
      },
      createOnce(context) {
        return {
          Program(node) {
            const comments = collectComments(node);
            for (const comment of comments) {
              if (!DISABLE_RE.test(comment.value)) {
                continue;
              }
              if (INLINE_DESCRIPTION_RE.test(comment.value)) {
                continue;
              }
              const lineAbove = comment.loc.start.line - 1;
              const documentedAbove = comments.some(
                (other) =>
                  other !== comment &&
                  !isDirective(other.value) &&
                  other.loc.end.line === lineAbove,
              );
              if (documentedAbove) {
                continue;
              }
              context.report({
                node: comment,
                messageId: "requireDescription",
              });
            }
          },
        };
      },
    },
    "no-foreign-directive": {
      meta: {
        type: "problem",
        messages: {
          noForeignDirective:
            "`{{kind}}` is not honoured by this toolchain (oxlint + oxfmt). " +
            "Remove it; use an oxlint disable directive or oxfmt formatting.",
          legacySpelling:
            "Write `{{kind}}` with the `oxlint-` prefix; the `eslint-` " +
            "spelling is a legacy alias.",
        },
      },
      createOnce(context) {
        return {
          Program(node) {
            for (const comment of collectComments(node)) {
              const match = FOREIGN_RE.exec(comment.value);
              if (match) {
                context.report({
                  node: comment,
                  messageId: "noForeignDirective",
                  data: { kind: match[0] },
                });
                continue;
              }
              const legacy = LEGACY_SPELLING_RE.exec(comment.value);
              const kind = legacy?.[1];
              if (kind !== undefined) {
                context.report({
                  node: comment,
                  messageId: "legacySpelling",
                  data: { kind },
                });
              }
            }
          },
        };
      },
    },
  },
});
