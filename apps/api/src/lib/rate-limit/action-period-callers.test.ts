import { describe, expect, test } from "bun:test";

import {
  isObjectLiteralProperty,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const srcRoot = new URL("../../", import.meta.url);
const propertyName = (property: ObjectProperty) => {
  if (property.computed) {
    return undefined;
  }
  if (property.key.type === "Identifier") {
    return property.key.name;
  }
  return property.key.type === "Literal" &&
    typeof property.key.value === "string"
    ? property.key.value
    : undefined;
};
const stringValue = (node: Node) =>
  node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
/** The `key: value` entries of an object literal. */
const assignments = (object: ObjectExpression) =>
  object.properties.filter(
    (property): property is ObjectProperty =>
      property.type === "Property" &&
      !property.shorthand &&
      !property.method &&
      property.kind === "init",
  );

describe("period identity coverage", () => {
  test("finite admission callers supply a phase identity and independent concurrency-only callers stay explicit", async () => {
    const callers: string[] = [];
    const concurrencyOnlyCallers: string[] = [];
    const declarations: string[] = [];
    const authorizedFiniteCallers: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync({
      cwd: srcRoot.pathname,
    })) {
      if (file.includes(".test.") || file.startsWith("tests/")) {
        continue;
      }
      const source = await Bun.file(new URL(file, srcRoot)).text();
      const parsed = parseSource(file, source);
      const admissionNames = new Set<string>();
      for (const { entries } of parsed.module.staticImports) {
        for (const { importName, localName } of entries) {
          if (importName.name === "withActionAdmission") {
            admissionNames.add(localName.value);
          }
        }
      }
      if (file === "lib/rate-limit/queued-action-admission.ts") {
        admissionNames.add("admission");
      }
      if (file === "lib/api-handlers.ts") {
        admissionNames.add("admit");
      }
      // Destructuring defaults (`{ admit = withActionAdmission }`) alias it.
      walk(parsed.program, (node, ancestors) => {
        const parent = ancestors.at(-1);
        if (
          node.type === "AssignmentPattern" &&
          (parent?.type === "ArrayPattern" ||
            (parent?.type === "Property" &&
              ancestors.at(-2)?.type === "ObjectPattern")) &&
          node.left.type === "Identifier" &&
          node.right.type === "Identifier" &&
          admissionNames.has(node.right.name)
        ) {
          admissionNames.add(node.left.name);
        }
      });
      walk(parsed.program, (node, ancestors) => {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          admissionNames.has(node.callee.name)
        ) {
          const options = node.arguments.at(0);
          expect(options?.type === "ObjectExpression", file).toBe(true);
          if (options?.type === "ObjectExpression") {
            const properties = assignments(options);
            const hasIndependentScope = properties.some(
              (property) =>
                propertyName(property) === "scope" &&
                stringValue(property.value) === "independent",
            );
            const hasPeriodIdentity = properties.some(
              (property) => propertyName(property) === "periodIdentity",
            );
            const isBackgroundJob = properties.some(
              (property) =>
                propertyName(property) === "execution" &&
                stringValue(property.value) === "background-job",
            );
            if (
              (hasIndependentScope || isBackgroundJob) &&
              !hasPeriodIdentity
            ) {
              concurrencyOnlyCallers.push(file);
            } else {
              callers.push(file);
              expect(hasPeriodIdentity, file).toBe(true);
            }
          }
        }
        if (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === "admitFiniteAction"
        ) {
          authorizedFiniteCallers.push(file);
          const options = node.arguments.at(0);
          expect(options?.type === "ObjectExpression", file).toBe(true);
          if (options?.type === "ObjectExpression") {
            expect(
              assignments(options).some(
                (property) =>
                  propertyName(property) === "actionKind" &&
                  (stringValue(property.value)?.length ?? 0) > 0,
              ),
              file,
            ).toBe(true);
          }
        }
        if (
          isObjectLiteralProperty(node, ancestors.at(-1)) &&
          !node.shorthand &&
          !node.method &&
          node.kind === "init" &&
          propertyName(node) === "actionAdmission"
        ) {
          declarations.push(file);
          expect(node.value.type === "ObjectExpression", file).toBe(true);
          if (node.value.type === "ObjectExpression") {
            expect(
              assignments(node.value).some(
                (property) =>
                  propertyName(property) === "actionKind" &&
                  (stringValue(property.value)?.length ?? 0) > 0,
              ),
              file,
            ).toBe(true);
          }
        }
      });
    }
    expect(callers.toSorted()).toEqual([
      "lib/api-handlers.ts",
      "lib/rate-limit/model-action-admission.ts",
      "lib/rate-limit/queued-action-admission.ts",
      "mcp/server-core.ts",
    ]);
    expect(concurrencyOnlyCallers.toSorted()).toEqual([
      "lib/rate-limit/execution-admission.ts",
      "lib/rate-limit/queued-action-admission.ts",
      "lib/rate-limit/queued-action-admission.ts",
    ]);
    expect(declarations.toSorted()).toEqual([
      "handlers/bilingual-translations/create-run.ts",
      "handlers/bilingual-translations/prepare.ts",
      "handlers/case-law/decisions/search-expand.ts",
      "handlers/case-law/decisions/search-refine.ts",
      "handlers/case-law/research/columns-suggest-prompt.ts",
      "handlers/chat/improve-prompt.ts",
      "handlers/chat/messages/revisions/span-edit.ts",
      "handlers/chat/table-chart.ts",
      "handlers/clauses/rewrite.ts",
      "handlers/clauses/versions/summarize.ts",
      "handlers/contacts/extract-procuracao.ts",
      "handlers/document-reviews/create-run.ts",
      "handlers/document-reviews/propose-positions.ts",
      "handlers/document-translations/runs/create.ts",
      "handlers/entities/placements/suggest.ts",
      "handlers/entities/versions/summarize.ts",
      "handlers/lists/verifications/create.ts",
      "handlers/properties/preview.ts",
      "handlers/properties/prompt/suggest.ts",
      "handlers/search/routes.ts",
      "handlers/search/routes.ts",
      "handlers/skills/drafts/generate.ts",
      "handlers/skills/proposals/from-comments/create.ts",
      "handlers/skills/resources/rewrite.ts",
      "handlers/templates/fields/suggest.ts",
      "handlers/templates/prepare.ts",
      "handlers/templates/versions/summarize.ts",
      "handlers/time-entries/polish-narrative.ts",
      "handlers/workspaces/generate-bounding-boxes.ts",
    ]);
    expect(authorizedFiniteCallers.toSorted()).toEqual([
      "handlers/chat/get-suggested-prompts.ts",
      "handlers/chat/get-thread-recap.ts",
      "handlers/chat/suggest-thread-title.ts",
      "handlers/document-reviews/parties.ts",
      "handlers/templates/prefill.ts",
    ]);
  });
});
