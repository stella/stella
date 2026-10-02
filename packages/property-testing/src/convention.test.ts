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

// Process-spawning exports, by module. A property predicate runs once per
// sample, so a spawn there multiplies process startup by numRuns and races
// Bun's per-test timeout.
const BUN_SPAWN_MEMBERS: ReadonlySet<string> = new Set([
  "$",
  "spawn",
  "spawnSync",
]);
const CHILD_PROCESS_SPAWNS: ReadonlySet<string> = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);
const SPAWN_MODULES: Record<string, ReadonlySet<string> | "all"> = {
  bun: BUN_SPAWN_MEMBERS,
  child_process: CHILD_PROCESS_SPAWNS,
  "node:child_process": CHILD_PROCESS_SPAWNS,
  execa: "all",
};
const PROPERTY_BUILDERS = new Set(["asyncProperty", "property"]);

type FunctionNode =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression;

// Reports property predicates that spawn a process, directly or through a
// function declared in the same file.
const inspectPropertySpawns = ({ relativePath, source }: PropertyTestFile) => {
  const parsed = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const fastCheckNamespaces = new Set<string>();
  const propertyBindings = new Set<string>();
  const spawnBindings = new Set<string>();
  const spawnNamespaces = new Map<string, ReadonlySet<string> | "all">();
  const functions = new Map<string, FunctionNode>();

  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const spawnExports = SPAWN_MODULES[specifier];
    const namespace =
      clause?.namedBindings !== undefined &&
      ts.isNamespaceImport(clause.namedBindings)
        ? clause.namedBindings.name.text
        : undefined;
    for (const name of [clause?.name?.text, namespace]) {
      if (name === undefined) {
        continue;
      }
      if (specifier === "fast-check") {
        fastCheckNamespaces.add(name);
      } else if (spawnExports !== undefined) {
        spawnNamespaces.set(name, spawnExports);
        if (name === clause?.name?.text && spawnExports === "all") {
          // `execa`'s default export is itself a spawn.
          spawnBindings.add(name);
        }
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
      if (specifier === "fast-check" && PROPERTY_BUILDERS.has(imported)) {
        propertyBindings.add(binding.name.text);
      }
      if (
        spawnExports === "all" ||
        (spawnExports !== undefined && spawnExports.has(imported))
      ) {
        spawnBindings.add(binding.name.text);
      }
    }
  }

  const collectFunctions = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      functions.set(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(parsed);

  const isSpawnCallee = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) {
      return spawnBindings.has(callee.text);
    }
    if (
      !ts.isPropertyAccessExpression(callee) ||
      !ts.isIdentifier(callee.expression)
    ) {
      return false;
    }
    const owner = callee.expression.text;
    if (owner === "Bun") {
      return BUN_SPAWN_MEMBERS.has(callee.name.text);
    }
    const exports = spawnNamespaces.get(owner);
    return (
      exports !== undefined &&
      (exports === "all" || exports.has(callee.name.text))
    );
  };

  const spawns = (node: ts.Node, seen: Set<string>): boolean => {
    let callee: ts.Expression | undefined;
    if (ts.isCallExpression(node)) {
      callee = node.expression;
    } else if (ts.isTaggedTemplateExpression(node)) {
      callee = node.tag;
    }
    if (callee !== undefined) {
      if (isSpawnCallee(callee)) {
        return true;
      }
      if (ts.isIdentifier(callee) && !seen.has(callee.text)) {
        const helper = functions.get(callee.text);
        if (helper !== undefined) {
          seen.add(callee.text);
          if (spawns(helper, seen)) {
            return true;
          }
        }
      }
    }
    return ts.forEachChild(node, (child) => spawns(child, seen)) ?? false;
  };

  const isPropertyBuilder = (callee: ts.Expression): boolean =>
    (ts.isIdentifier(callee) && propertyBindings.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      fastCheckNamespaces.has(callee.expression.text) &&
      PROPERTY_BUILDERS.has(callee.name.text));

  const violations: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isPropertyBuilder(node.expression)) {
      const predicate = node.arguments.at(-1);
      const resolved =
        predicate !== undefined && ts.isIdentifier(predicate)
          ? functions.get(predicate.text)
          : predicate;
      if (resolved !== undefined && spawns(resolved, new Set())) {
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart());
        violations.push(
          `${relativePath}:${line + 1}: property predicate spawns a process per sample; evaluate it in process or draw the samples and run them as one batch`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return violations;
};

const collectSpawningProperties = async (): Promise<string[]> => {
  const violations: string[] = [];
  for await (const relativePath of new Bun.Glob("scripts/**/*.test.ts").scan({
    cwd: REPO_ROOT,
  })) {
    if (relativePath.includes("node_modules")) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    if (source.includes("fast-check")) {
      violations.push(...inspectPropertySpawns({ relativePath, source }));
    }
  }
  return violations.toSorted();
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

  test("no root tooling property predicate spawns a process", async () => {
    expect(await collectSpawningProperties()).toEqual([]);
  });

  test("finds spawns in predicates directly and through local helpers", () => {
    const source = `
      import fc, { property as prop } from "fast-check";
      import * as childProcess from "node:child_process";
      import { execSync as run } from "child_process";
      import { execa } from "execa";
      const plan = (files) => Bun.spawnSync(["bash", ...files]);
      const indirect = (files) => plan(files).exitCode;
      function shell(command) { return Bun.$\`\${command}\`; }
      const predicate = (files) => { indirect(files); };
      fc.property(fc.string(), (file) => { Bun.spawnSync(["true", file]); });
      fc.property(fc.string(), (file) => { indirect([file]); });
      prop(fc.string(), (file) => { shell(file); });
      fc.asyncProperty(fc.string(), async (file) => { await execa("echo", [file]); });
      fc.property(fc.string(), (file) => { childProcess.spawnSync("echo", [file]); });
      fc.property(fc.string(), (file) => { run(file); });
      fc.property(fc.string(), predicate);
    `;
    expect(
      inspectPropertySpawns({ relativePath: "fixture.test.ts", source }).map(
        (violation) => violation.split(":").at(1),
      ),
    ).toEqual(["10", "11", "12", "13", "14", "15", "16"]);
  });

  test("allows spawns outside predicates and pure helper calls inside them", () => {
    const source = `
      import fc from "fast-check";
      const plans = Bun.spawnSync(["bash", "-c", "true"]);
      const pure = (file) => file.length;
      const recursive = (file) => (file === "" ? 0 : recursive(file.slice(1)));
      fc.assert(fc.property(fc.string(), (file) => { pure(file); recursive(file); }));
      const draws = fc.sample(fc.string(), 10);
    `;
    expect(
      inspectPropertySpawns({ relativePath: "fixture.test.ts", source }),
    ).toEqual([]);
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
   * Guard: the nightly sweep runs each workspace's `test:property`, so a
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
