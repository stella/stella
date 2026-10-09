import { describe, expect, test } from "bun:test";
import ts from "typescript";

const srcRoot = new URL("../../", import.meta.url);
const propertyName = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

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
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const admissionNames = new Set<string>();
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement)) {
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) {
          continue;
        }
        for (const binding of bindings.elements) {
          if (
            (binding.propertyName ?? binding.name).text ===
            "withActionAdmission"
          ) {
            admissionNames.add(binding.name.text);
          }
        }
      }
      if (file === "lib/rate-limit/queued-action-admission.ts") {
        admissionNames.add("admission");
      }
      if (file === "lib/api-handlers.ts") {
        admissionNames.add("admit");
      }
      const discoverAdmissionDefaults = (node: ts.Node): void => {
        if (
          ts.isBindingElement(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          admissionNames.has(node.initializer.text)
        ) {
          admissionNames.add(node.name.text);
        }
        ts.forEachChild(node, discoverAdmissionDefaults);
      };
      discoverAdmissionDefaults(tree);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          admissionNames.has(node.expression.text)
        ) {
          const options = node.arguments.at(0);
          expect(options && ts.isObjectLiteralExpression(options), file).toBe(
            true,
          );
          if (options && ts.isObjectLiteralExpression(options)) {
            const hasIndependentScope = options.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                propertyName(property.name) === "scope" &&
                ts.isStringLiteral(property.initializer) &&
                property.initializer.text === "independent",
            );
            const hasPeriodIdentity = options.properties.some(
              (property) =>
                (ts.isPropertyAssignment(property) ||
                  ts.isShorthandPropertyAssignment(property)) &&
                propertyName(property.name) === "periodIdentity",
            );
            const isBackgroundJob = options.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                propertyName(property.name) === "execution" &&
                ts.isStringLiteral(property.initializer) &&
                property.initializer.text === "background-job",
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
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "admitFiniteAction"
        ) {
          authorizedFiniteCallers.push(file);
          const options = node.arguments.at(0);
          expect(options && ts.isObjectLiteralExpression(options), file).toBe(
            true,
          );
          if (options && ts.isObjectLiteralExpression(options)) {
            expect(
              options.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  propertyName(property.name) === "actionKind" &&
                  ts.isStringLiteral(property.initializer) &&
                  property.initializer.text.length > 0,
              ),
              file,
            ).toBe(true);
          }
        }
        if (
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === "actionAdmission"
        ) {
          declarations.push(file);
          expect(ts.isObjectLiteralExpression(node.initializer), file).toBe(
            true,
          );
          if (ts.isObjectLiteralExpression(node.initializer)) {
            expect(
              node.initializer.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  propertyName(property.name) === "actionKind" &&
                  ts.isStringLiteral(property.initializer) &&
                  property.initializer.text.length > 0,
              ),
              file,
            ).toBe(true);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
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
