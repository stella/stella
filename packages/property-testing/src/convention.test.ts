import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const TEST_FILE_GLOB = "{apps,packages}/**/*.test.{ts,tsx}";
const PACKAGE_JSON_GLOB = "{apps,packages}/*/package.json";

const PROPERTY_SCRIPT = "test:property";

// This guard names the marker in its own source and is not a property test.
const SELF_PATH = "packages/property-testing/src/convention.test.ts";

type PropertyTestFile = { relativePath: string; source: string };

const collectPropertyTestFiles = async (): Promise<PropertyTestFile[]> => {
  const glob = new Bun.Glob(TEST_FILE_GLOB);
  const files: PropertyTestFile[] = [];
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    if (
      relativePath.includes("node_modules") ||
      relativePath.startsWith("packages/property-testing/")
    ) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    if (
      (source.includes("fast-check") ||
        source.includes("@stll/property-testing")) &&
      inspectPropertyTest({ relativePath, source }).propertyCalls > 0
    ) {
      files.push({ relativePath, source });
    }
  }
  return files;
};

const inspectPropertyTest = ({ relativePath, source }: PropertyTestFile) => {
  const parsed = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const configurationBindings = new Set<string>();
  const fastCheckBindings = new Set<string>();
  const runnerBindings = new Set<string>();
  const assertionBindings = new Set<string>();
  let propertyCalls = 0;
  const initializers = new Map<string, ts.Expression>();
  const violations: string[] = [];

  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (statement.moduleSpecifier.text === "fast-check") {
      if (clause?.name !== undefined) {
        fastCheckBindings.add(clause.name.text);
      }
      if (
        clause?.namedBindings !== undefined &&
        ts.isNamespaceImport(clause.namedBindings)
      ) {
        fastCheckBindings.add(clause.namedBindings.name.text);
      }
    }
    if (
      clause?.namedBindings === undefined ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      continue;
    }
    for (const binding of clause.namedBindings.elements) {
      const imported = binding.propertyName?.text ?? binding.name.text;
      if (
        statement.moduleSpecifier.text === "@stll/property-testing" &&
        imported === "propertyConfig"
      ) {
        configurationBindings.add(binding.name.text);
      }
      if (
        statement.moduleSpecifier.text === "@stll/property-testing" &&
        imported === "assertProperty"
      ) {
        assertionBindings.add(binding.name.text);
      }
      if (
        statement.moduleSpecifier.text === "fast-check" &&
        (imported === "assert" || imported === "check")
      ) {
        runnerBindings.add(binding.name.text);
      }
    }
  }

  const collectInitializers = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(parsed);

  const configured = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): boolean => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return configured(expression.expression, seen);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some(
        (member) =>
          ts.isSpreadAssignment(member) && configured(member.expression, seen),
      );
    }
    if (ts.isArrowFunction(expression) && !ts.isBlock(expression.body)) {
      return configured(expression.body, seen);
    }
    const identifier = ts.isCallExpression(expression)
      ? expression.expression
      : expression;
    if (!ts.isIdentifier(identifier)) {
      return false;
    }
    if (
      ts.isCallExpression(expression) &&
      configurationBindings.has(identifier.text)
    ) {
      return true;
    }
    if (seen.has(identifier.text)) {
      return false;
    }
    seen.add(identifier.text);
    const initializer = initializers.get(identifier.text);
    return initializer !== undefined && configured(initializer, seen);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const namedRunner =
        ts.isIdentifier(callee) && runnerBindings.has(callee.text);
      let member: string | undefined;
      if (ts.isPropertyAccessExpression(callee)) {
        member = callee.name.text;
      } else if (
        ts.isElementAccessExpression(callee) &&
        ts.isStringLiteral(callee.argumentExpression)
      ) {
        member = callee.argumentExpression.text;
      }
      const namespaceRunner =
        (ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)) &&
        ts.isIdentifier(callee.expression) &&
        fastCheckBindings.has(callee.expression.text) &&
        (member === "assert" || member === "check");
      if (ts.isIdentifier(callee) && assertionBindings.has(callee.text)) {
        propertyCalls += 1;
      }
      if (namedRunner || namespaceRunner) {
        propertyCalls += 1;
        const parameters = node.arguments.at(1);
        if (parameters === undefined || !configured(parameters)) {
          const { line } = parsed.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          violations.push(
            `${relativePath}:${line + 1}: property runner must pass propertyConfig parameters`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { violations, propertyCalls };
};

const collectViolations = async (): Promise<string[]> => {
  const violations: string[] = [];
  // Root tooling tests also exercise properties, outside workspace runners.
  for await (const relativePath of new Bun.Glob(
    "{apps,packages,scripts}/**/*.test.{ts,tsx}",
  ).scan({ cwd: REPO_ROOT })) {
    if (relativePath.includes("node_modules") || relativePath === SELF_PATH) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    if (source.includes("fast-check")) {
      violations.push(
        ...inspectPropertyTest({ relativePath, source }).violations,
      );
    }
  }
  return violations.toSorted();
};

// Workspace directory ("apps/web", "packages/boe") of a repo-relative path.
const workspaceOf = (relativePath: string): string =>
  relativePath.split("/").slice(0, 2).join("/");

const collectPropertyScriptWorkspaces = async (): Promise<Set<string>> => {
  const glob = new Bun.Glob(PACKAGE_JSON_GLOB);
  const workspaces = new Set<string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    const manifest: { scripts?: Record<string, string> } = await Bun.file(
      path.resolve(REPO_ROOT, relativePath),
    ).json();
    if (manifest.scripts?.[PROPERTY_SCRIPT] !== undefined) {
      workspaces.add(workspaceOf(relativePath));
    }
  }
  return workspaces;
};

const collectPropertyScriptCommands = async (): Promise<
  Map<string, string>
> => {
  const glob = new Bun.Glob(PACKAGE_JSON_GLOB);
  const commands = new Map<string, string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    const manifest: { scripts?: Record<string, string> } = await Bun.file(
      path.resolve(REPO_ROOT, relativePath),
    ).json();
    const command = manifest.scripts?.[PROPERTY_SCRIPT];
    if (command !== undefined) {
      commands.set(workspaceOf(relativePath), command);
    }
  }
  return commands;
};

describe("property-test convention", () => {
  test("every property runner call uses configured parameters", async () => {
    expect(await collectViolations()).toEqual([]);
  });

  test("checks each call rather than the presence of an import", () => {
    const source = `
      import fc from "fast-check";
      import { propertyConfig } from "@stll/property-testing";
      fc.assert(property, propertyConfig());
      fc.assert(property);
      fc.check(property, { numRuns: 10 });
      fc.assert(property, { unrelated: propertyConfig() });
    `;
    const { violations } = inspectPropertyTest({
      relativePath: "fixture.test.ts",
      source,
    });
    expect(violations).toHaveLength(3);
    expect(violations.map((value) => value.split(":").at(1))).toEqual([
      "5",
      "6",
      "7",
    ]);
  });

  test("recognizes configured helpers, aliases, and parameter values", () => {
    const source = `
      import fc, { check as run } from "fast-check";
      import { propertyConfig as configure, assertProperty } from "@stll/property-testing";
      const config = (numRuns) => configure({ numRuns });
      const parameters = configure();
      fc.assert(property, config(10));
      fc.check(property, parameters);
      run(property, configure());
      assertProperty("fixture", property);
      const text = "fc.assert(property)";
    `;
    expect(
      inspectPropertyTest({ relativePath: "fixture.test.ts", source })
        .violations,
    ).toEqual([]);
  });

  test("counts properties using only the shared assertion helper", () => {
    const result = inspectPropertyTest({
      relativePath: "fixture.test.ts",
      source: `
      import { assertProperty as assert } from "@stll/property-testing";
      assert("fixture", property);
    `,
    });
    expect(result.propertyCalls).toBe(1);
    expect(result.violations).toEqual([]);
    expect(
      inspectPropertyTest({
        relativePath: "fixture.test.ts",
        source: 'const text = "fc.assert(property)";',
      }).propertyCalls,
    ).toBe(0);
  });

  test("property runners preload the factor-scaled Bun timeout", async () => {
    const commands = await collectPropertyScriptCommands();
    const violations = [...commands].flatMap(([workspace, command]) =>
      /--preload\s+@stll\/property-testing\/preload(?:\s|$)/u.test(command)
        ? []
        : [`${workspace}: test:property does not preload property-testing`],
    );

    expect(violations).toEqual([]);
  });

  test("every workspace property selector includes both assertion APIs", async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "property-selectors-"));
    const legacyPath = "src/legacy.test.ts";
    const sharedPath = "src/shared.test.ts";
    const expectedPaths = [legacyPath, sharedPath];
    try {
      mkdirSync(path.join(fixtureRoot, "src"));
      await Promise.all([
        Bun.write(path.join(fixtureRoot, legacyPath), "fc.assert(property);"),
        Bun.write(
          path.join(fixtureRoot, sharedPath),
          'assertProperty("shared", property);',
        ),
        Bun.write(
          path.join(fixtureRoot, "src/ordinary.test.ts"),
          'test("ordinary", () => {});',
        ),
      ]);
      const violations: string[] = [];
      for (const [
        workspace,
        command,
      ] of await collectPropertyScriptCommands()) {
        if (workspace === "apps/api") {
          if (
            // The API generates the CLI runtime modules it imports first.
            !/^(?:bun --cwd=\.\.\/\.\.\/packages\/cli run codegen:runtime && )?bun scripts\/run-tests\.ts\s+--property(?:\s|$)/u.test(
              command,
            )
          ) {
            violations.push(
              `${workspace}: test:property does not use the property selector`,
            );
            continue;
          }
          continue;
        }
        // Exercise the manifest's selector without starting the test runner.
        const selector = /\$\((grep\s[^)]+)\)/u.exec(command)?.at(1);
        if (selector === undefined) {
          violations.push(
            `${workspace}: test:property has no recognized property selector`,
          );
          continue;
        }
        const selectionProcess = Bun.spawn(["sh", "-c", selector], {
          cwd: fixtureRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, error, exitCode] = await Promise.all([
          new Response(selectionProcess.stdout).text(),
          new Response(selectionProcess.stderr).text(),
          selectionProcess.exited,
        ]);
        const selected = output.trim().split("\n").filter(Boolean).toSorted();
        if (
          exitCode !== 0 ||
          JSON.stringify(selected) !== JSON.stringify(expectedPaths)
        ) {
          violations.push(
            `${workspace}: selected ${JSON.stringify(selected)} (exit ${exitCode}, ${error.trim()})`,
          );
        }
      }
      expect(violations).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  /**
   * Guard: the nightly property job runs `turbo run test:property`, so a
   * property test in a workspace without that script never gets the scaled
   * numRuns budget; it runs at its PR budget forever while looking covered.
   * Conversely a workspace with the script but no property file would run
   * its whole suite (`bun test` with an empty selection). Assert the two sets
   * match in both directions.
   */
  test("workspaces with fc.assert tests and test:property scripts coincide", async () => {
    const withPropertyTests = new Set(
      (await collectPropertyTestFiles()).map(({ relativePath }) =>
        workspaceOf(relativePath),
      ),
    );
    const withScript = await collectPropertyScriptWorkspaces();
    expect(withPropertyTests.size).toBeGreaterThan(0);
    expect([...withPropertyTests].toSorted()).toEqual(
      [...withScript].toSorted(),
    );
  });
});
