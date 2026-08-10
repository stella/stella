// A graded playbook position is two properties that mean one thing: the ASK
// holding the extracted value, and a `playbook-verdict` grading it. "Missing"
// says nothing without the answer it was reached from, so no surface may list
// them as two independent properties.
//
// The rule existed only as a comment beside the table's column builder. The
// inspector's metadata panel, written later, discriminated on the tool type
// itself and got it wrong: every verdict rendered as a row of its own, stranded
// from the value it graded. Turning this rule on found four more files that had
// already gone the same way.
//
// So the tool name is only spellable where the pairing is owned, where the
// union is declared, and where it is deserialised from the API. Everywhere
// else, call `pairPlaybookVerdicts` to list properties, or
// `isPlaybookVerdictProperty` / `isGradableProperty` to test one.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { filenameForContext, isAstNode } from "./utils.ts";

const VERDICT_TOOL_NAME = "playbook-verdict";

const OWNING_FILES = [
  // Owns the pairing.
  "apps/web/src/lib/workspaces/playbook-verdicts.ts",
  // Declares the tool union the pairing narrows.
  "apps/web/src/lib/types.ts",
  // Deserialises the union from the API: it has to name the variant to build
  // it, and it produces the properties every other surface then pairs.
  "apps/web/src/lib/workspaces/queries/properties.ts",
];

/** Fixtures name the variant to construct one; they render nothing. */
const isTestFile = (filename: string): boolean =>
  /\.(?:test|spec)\.tsx?$/u.test(filename);

const isVerdictLiteral = (node: unknown): boolean =>
  isAstNode(node) && node.type === "Literal" && node.value === VERDICT_TOOL_NAME;

/** Whether this expression reads `<something>.tool.type`. */
const isToolTypeAccess = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "MemberExpression" || node.computed) {
    return false;
  }
  const property = node.property;
  if (!isAstNode(property) || property.name !== "type") {
    return false;
  }
  const object = node.object;
  return (
    isAstNode(object) &&
    object.type === "MemberExpression" &&
    object.computed !== true &&
    isAstNode(object.property) &&
    object.property.name === "tool"
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-unpaired-playbook-verdict" },
  rules: {
    "no-unpaired-playbook-verdict": {
      meta: {
        type: "problem",
        messages: {
          handRolled:
            "Do not discriminate on the 'playbook-verdict' tool here. Use " +
            "pairPlaybookVerdicts from '@/lib/workspaces/playbook-verdicts' " +
            "to list properties, or isPlaybookVerdictProperty / " +
            "isGradableProperty to test one, so a verdict is never rendered " +
            "apart from the value it grades.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            if (
              isTestFile(filename) ||
              OWNING_FILES.some((owner) => filename.endsWith(owner))
            ) {
              return false;
            }
            return (
              filename.includes("apps/web/src/") ||
              filename.endsWith(
                ".oxlint-plugins/__fixtures__/no-unpaired-playbook-verdict.fixture.ts",
              )
            );
          },
          // Only a runtime comparison against a property's `tool.type`. The
          // same string legitimately names an unrelated justification-block
          // kind, and `Exclude<..., { type: "playbook-verdict" }>` is how the
          // variant is narrowed at the type level — neither can render a
          // verdict on its own, so neither is this rule's business.
          BinaryExpression(node) {
            if (node.operator !== "===" && node.operator !== "!==") {
              return;
            }
            const compared = isVerdictLiteral(node.right)
              ? node.left
              : isVerdictLiteral(node.left)
                ? node.right
                : null;
            if (compared === null || !isToolTypeAccess(compared)) {
              return;
            }
            context.report({ node, messageId: "handRolled" });
          },
        };
      },
    },
  },
});
