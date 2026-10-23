import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isIdentifierReference,
  isTestFile,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-direct-folio-snapshot-retirement";
const OWNER_PATH = "apps/api/src/lib/files/folio-collab-snapshot-retirement.ts";
const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-folio-snapshot-retirement.fixture.ts";
const RETIREMENT_VALUES = new Map([
  ["yjsSnapshotRevision", 0],
  ["savedSnapshotCut", null],
  ["yjsSnapshotSizeBytes", null],
  ["yjsSnapshotUpdatedAt", null],
]);

// Extracted update payloads and immutable aliases retain the restriction.
// Mutable values and raw SQL are outside this syntax guard's boundary.
const retirementValue = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): unknown => {
  const expression = unwrapExpression(value);
  if (expression === null || seen.has(expression)) {
    return undefined;
  }
  seen.add(expression);
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable === null
      ? undefined
      : retirementValue(context, stableInitializer(variable), seen);
  }
  return expression.type === "Literal" ? expression.value : undefined;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          directRetirement:
            "Retire folio snapshots through retireFolioCollabSnapshot so the revision reset preserves the discarded-changes marker atomically.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              filename.endsWith(FIXTURE_FILE_SUFFIX) ||
              (filename.includes("apps/api/src/") &&
                !filename.endsWith(OWNER_PATH) &&
                !isTestFile(filename))
            );
          },
          Property(node) {
            if (node.parent.type !== "ObjectExpression") {
              return;
            }
            const name = node.computed
              ? retirementValue(context, node.key)
              : getPropertyName(node.key);
            if (typeof name !== "string" || !RETIREMENT_VALUES.has(name)) {
              return;
            }
            if (
              retirementValue(context, node.value) ===
              RETIREMENT_VALUES.get(name)
            ) {
              context.report({ node, messageId: "directRetirement" });
            }
          },
        };
      },
    },
  },
});
