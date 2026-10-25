import { describe, expect, test } from "bun:test";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

const srcRoot = new URL("../../", import.meta.url);
const propertyName = (name: Node): string | undefined => {
  if (name.type === "Identifier") {
    return name.name;
  }
  if (name.type === "Literal" && typeof name.value === "string") {
    return name.value;
  }
  return undefined;
};

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
      const tree = parseSource(file, source);
      const admissionNames = new Set<string>();
      for (const statement of tree.program.body) {
        if (statement.type !== "ImportDeclaration") {
          continue;
        }
        for (const binding of statement.specifiers) {
          if (binding.type !== "ImportSpecifier") {
            continue;
          }
          const name =
            binding.imported.type === "Identifier"
              ? binding.imported.name
              : binding.imported.value;
          if (name === "withActionAdmission") {
            admissionNames.add(binding.local.name);
          }
        }
      }
      if (file === "lib/rate-limit/queued-action-admission.ts") {
        admissionNames.add("admission");
      }
      if (file === "lib/api-handlers.ts") {
        admissionNames.add("admit");
      }
      walk(tree.program, (node) => {
        if (
          node.type === "AssignmentPattern" &&
          node.left.type === "Identifier" &&
          node.right.type === "Identifier" &&
          admissionNames.has(node.right.name)
        ) {
          admissionNames.add(node.left.name);
        }
      });
      walk(tree.program, (node) => {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          admissionNames.has(node.callee.name)
        ) {
          const options = node.arguments.at(0);
          expect(options?.type === "ObjectExpression", file).toBe(true);
          if (options?.type === "ObjectExpression") {
            const hasIndependentScope = options.properties.some(
              (property) =>
                property.type === "Property" &&
                property.kind === "init" &&
                !property.method &&
                !property.shorthand &&
                propertyName(property.key) === "scope" &&
                property.value.type === "Literal" &&
                typeof property.value.value === "string" &&
                property.value.value === "independent",
            );
            const hasPeriodIdentity = options.properties.some(
              (property) =>
                property.type === "Property" &&
                property.kind === "init" &&
                !property.method &&
                !property.shorthand &&
                propertyName(property.key) === "periodIdentity",
            );
            const isBackgroundJob = options.properties.some(
              (property) =>
                property.type === "Property" &&
                property.kind === "init" &&
                !property.method &&
                !property.shorthand &&
                propertyName(property.key) === "execution" &&
                property.value.type === "Literal" &&
                typeof property.value.value === "string" &&
                property.value.value === "background-job",
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
              options.properties.some(
                (property) =>
                  property.type === "Property" &&
                  property.kind === "init" &&
                  !property.method &&
                  !property.shorthand &&
                  propertyName(property.key) === "actionKind" &&
                  property.value.type === "Literal" &&
                  typeof property.value.value === "string" &&
                  property.value.value.length > 0,
              ),
              file,
            ).toBe(true);
          }
        }
        if (
          node.type === "Property" &&
          node.kind === "init" &&
          !node.method &&
          !node.shorthand &&
          propertyName(node.key) === "actionAdmission"
        ) {
          declarations.push(file);
          expect(node.value.type === "ObjectExpression", file).toBe(true);
          if (node.value.type === "ObjectExpression") {
            expect(
              node.value.properties.some(
                (property) =>
                  property.type === "Property" &&
                  property.kind === "init" &&
                  !property.method &&
                  !property.shorthand &&
                  propertyName(property.key) === "actionKind" &&
                  property.value.type === "Literal" &&
                  typeof property.value.value === "string" &&
                  property.value.value.length > 0,
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
