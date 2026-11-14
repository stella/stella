import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ArrowFunctionExpression,
  type Expression,
  type Function as OxcFunction,
  type Node,
  parseSync,
  Visitor,
  visitorKeys,
} from "oxc-parser";

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const parsePropertySource = (file: string, source: string) => {
  const parsed = parseSync(file, source);
  const errors = parsed.errors.filter((error) => {
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (errors.length > 0) {
    panic(
      `${file} does not parse: ${errors.map(({ message }) => message).join("; ")}`,
    );
  }
  return parsed.program;
};
const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const PACKAGE_JSON_GLOB = "{apps,packages}/*/package.json";

const PROPERTY_SCRIPT = "test:property";

// This guard names the marker in its own source and is not a property test.
const SELF_PATH = "packages/property-testing/src/convention.test.ts";

type PropertyTestFile = { relativePath: string; source: string };

// Files read at once while scanning; macOS defaults to 256 open descriptors.
const READ_CONCURRENCY = 64;

// Every test file that mentions fast-check or the shared helpers, read once
// when the module loads. The guards below filter this list in memory, so no
// test body walks the repository (three serial whole-repository walks inside
// test bodies used to outlast Bun's per-test timeout on a loaded runner).
const scanPropertyCandidates = async (): Promise<PropertyTestFile[]> => {
  const relativePaths: string[] = [];
  for await (const relativePath of new Bun.Glob(
    "{apps,packages,scripts}/**/*.test.{ts,tsx}",
  ).scan({ cwd: REPO_ROOT })) {
    if (!relativePath.includes("node_modules")) {
      relativePaths.push(relativePath);
    }
  }
  const candidates: PropertyTestFile[] = [];
  for (let start = 0; start < relativePaths.length; start += READ_CONCURRENCY) {
    const batch = await Promise.all(
      relativePaths
        .slice(start, start + READ_CONCURRENCY)
        .map(async (relativePath) => ({
          relativePath,
          source: await Bun.file(path.resolve(REPO_ROOT, relativePath)).text(),
        })),
    );
    candidates.push(
      ...batch.filter(
        ({ source }) =>
          source.includes("fast-check") ||
          source.includes("@stll/property-testing"),
      ),
    );
  }
  return candidates.toSorted((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
};

const PROPERTY_CANDIDATES = await scanPropertyCandidates();

// One syntax parse per file, shared by every guard that inspects it.
const inspections = new Map<string, ReturnType<typeof inspectPropertyTest>>();
const inspectOnce = (file: PropertyTestFile) => {
  const cached = inspections.get(file.relativePath);
  if (cached !== undefined) {
    return cached;
  }
  const inspection = inspectPropertyTest(file);
  inspections.set(file.relativePath, inspection);
  return inspection;
};

const collectPropertyTestFiles = (): PropertyTestFile[] =>
  PROPERTY_CANDIDATES.filter(
    (file) =>
      !file.relativePath.startsWith("scripts/") &&
      !file.relativePath.startsWith("packages/property-testing/") &&
      inspectOnce(file).propertyCalls > 0,
  );

const inspectPropertyTest = ({ relativePath, source }: PropertyTestFile) => {
  const parsed = parsePropertySource(relativePath, source);
  const configurationBindings = new Set<string>();
  const fastCheckBindings = new Set<string>();
  const runnerBindings = new Set<string>();
  const assertionBindings = new Set<string>();
  let propertyCalls = 0;
  const initializers = new Map<string, Expression>();
  const violations: string[] = [];

  for (const statement of parsed.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (
        statement.source.value === "fast-check" &&
        (binding.type === "ImportDefaultSpecifier" ||
          binding.type === "ImportNamespaceSpecifier")
      ) {
        fastCheckBindings.add(binding.local.name);
      }
      if (binding.type !== "ImportSpecifier") {
        continue;
      }
      const imported =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
      if (
        statement.source.value === "@stll/property-testing" &&
        imported === "propertyConfig"
      ) {
        configurationBindings.add(binding.local.name);
      }
      if (
        statement.source.value === "@stll/property-testing" &&
        imported === "assertProperty"
      ) {
        assertionBindings.add(binding.local.name);
      }
      if (
        statement.source.value === "fast-check" &&
        (imported === "assert" || imported === "check")
      ) {
        runnerBindings.add(binding.local.name);
      }
    }
  }

  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init !== null) {
        initializers.set(node.id.name, node.init);
      }
    },
  }).visit(parsed);

  const configured = (
    expression: Expression,
    seen = new Set<string>(),
  ): boolean => {
    if (
      expression.type === "ParenthesizedExpression" ||
      expression.type === "TSAsExpression" ||
      expression.type === "TSSatisfiesExpression"
    ) {
      return configured(expression.expression, seen);
    }
    if (expression.type === "ObjectExpression") {
      return expression.properties.some(
        (member) =>
          member.type === "SpreadElement" && configured(member.argument, seen),
      );
    }
    if (
      expression.type === "ArrowFunctionExpression" &&
      expression.body.type !== "BlockStatement"
    ) {
      return configured(expression.body, seen);
    }
    const identifier =
      expression.type === "CallExpression" ? expression.callee : expression;
    if (identifier.type !== "Identifier") {
      return false;
    }
    if (
      expression.type === "CallExpression" &&
      configurationBindings.has(identifier.name)
    ) {
      return true;
    }
    if (seen.has(identifier.name)) {
      return false;
    }
    seen.add(identifier.name);
    const initializer = initializers.get(identifier.name);
    return initializer !== undefined && configured(initializer, seen);
  };

  new Visitor({
    CallExpression(node) {
      const callee = node.callee;
      const namedRunner =
        callee.type === "Identifier" && runnerBindings.has(callee.name);
      let member: string | undefined;
      if (callee.type === "MemberExpression") {
        if (!callee.computed && callee.property.type === "Identifier") {
          member = callee.property.name;
        } else if (
          callee.computed &&
          callee.property.type === "Literal" &&
          typeof callee.property.value === "string"
        ) {
          member = callee.property.value;
        }
      }
      const namespaceRunner =
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        fastCheckBindings.has(callee.object.name) &&
        (member === "assert" || member === "check");
      if (callee.type === "Identifier" && assertionBindings.has(callee.name)) {
        propertyCalls += 1;
      }
      if (namedRunner || namespaceRunner) {
        propertyCalls += 1;
        const parameters = node.arguments.at(1);
        if (
          parameters === undefined ||
          parameters.type === "SpreadElement" ||
          !configured(parameters)
        ) {
          violations.push(
            `${relativePath}:${lineOf(source, node.start)}: property runner must pass propertyConfig parameters`,
          );
        }
      }
    },
  }).visit(parsed);
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

type FunctionNode = ArrowFunctionExpression | OxcFunction;

// Reports property predicates that spawn a process, directly or through a
// function declared in the same file.
const inspectPropertySpawns = ({ relativePath, source }: PropertyTestFile) => {
  const parsed = parsePropertySource(relativePath, source);
  const fastCheckNamespaces = new Set<string>();
  const propertyBindings = new Set<string>();
  const spawnBindings = new Set<string>();
  const spawnNamespaces = new Map<string, ReadonlySet<string> | "all">();
  const functions = new Map<string, FunctionNode>();

  for (const statement of parsed.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const specifier = statement.source.value;
    const spawnExports = SPAWN_MODULES[specifier];
    for (const binding of statement.specifiers) {
      const name = binding.local.name;
      if (
        binding.type === "ImportDefaultSpecifier" ||
        binding.type === "ImportNamespaceSpecifier"
      ) {
        if (specifier === "fast-check") {
          fastCheckNamespaces.add(name);
        } else if (spawnExports !== undefined) {
          spawnNamespaces.set(name, spawnExports);
          if (
            binding.type === "ImportDefaultSpecifier" &&
            spawnExports === "all"
          ) {
            spawnBindings.add(name);
          }
        }
        continue;
      }
      const imported =
        binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value;
      if (specifier === "fast-check" && PROPERTY_BUILDERS.has(imported)) {
        propertyBindings.add(name);
      }
      if (spawnExports === "all" || spawnExports?.has(imported) === true) {
        spawnBindings.add(name);
      }
    }
  }

  new Visitor({
    FunctionDeclaration(node) {
      if (node.id !== null) {
        functions.set(node.id.name, node);
      }
    },
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier" &&
        (node.init?.type === "ArrowFunctionExpression" ||
          node.init?.type === "FunctionExpression")
      ) {
        functions.set(node.id.name, node.init);
      }
    },
  }).visit(parsed);

  const isSpawnCallee = (callee: Expression): boolean => {
    if (callee.type === "Identifier") {
      return spawnBindings.has(callee.name);
    }
    if (
      callee.type !== "MemberExpression" ||
      callee.computed ||
      callee.object.type !== "Identifier" ||
      callee.property.type !== "Identifier"
    ) {
      return false;
    }
    const owner = callee.object.name;
    if (owner === "Bun") {
      return BUN_SPAWN_MEMBERS.has(callee.property.name);
    }
    const exports = spawnNamespaces.get(owner);
    return (
      exports !== undefined &&
      (exports === "all" || exports.has(callee.property.name))
    );
  };

  const spawns = (node: Node, seen: Set<string>): boolean => {
    let found = false;
    const inspectCallee = (callee: Expression) => {
      if (isSpawnCallee(callee)) {
        found = true;
      }
      if (callee.type === "Identifier" && !seen.has(callee.name)) {
        const helper = functions.get(callee.name);
        if (helper !== undefined) {
          seen.add(callee.name);
          found ||= spawns(helper, seen);
        }
      }
    };
    // oxc's Visitor walks only a Program; a helper is a function node, so its
    // subtree is walked by its own visitor keys.
    const enter = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          enter(item);
        }
        return;
      }
      if (!isNode(value)) {
        return;
      }
      if (value.type === "CallExpression") {
        inspectCallee(value.callee);
      } else if (value.type === "TaggedTemplateExpression") {
        inspectCallee(value.tag);
      }
      for (const key of visitorKeys[value.type] ?? []) {
        enter(Reflect.get(value, key));
      }
    };
    enter(node);
    return found;
  };

  const isPropertyBuilder = (callee: Expression): boolean =>
    (callee.type === "Identifier" && propertyBindings.has(callee.name)) ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      fastCheckNamespaces.has(callee.object.name) &&
      callee.property.type === "Identifier" &&
      PROPERTY_BUILDERS.has(callee.property.name));

  const violations: string[] = [];
  new Visitor({
    CallExpression(node) {
      if (!isPropertyBuilder(node.callee)) {
        return;
      }
      const predicate = node.arguments.at(-1);
      const resolved =
        predicate?.type === "Identifier"
          ? functions.get(predicate.name)
          : predicate;
      if (resolved !== undefined && spawns(resolved, new Set())) {
        violations.push(
          `${relativePath}:${lineOf(source, node.start)}: property predicate spawns a process per sample; evaluate it in process or draw the samples and run them as one batch`,
        );
      }
    },
  }).visit(parsed);

  return violations;
};

const collectSpawningProperties = (): string[] =>
  PROPERTY_CANDIDATES.filter(
    ({ relativePath, source }) =>
      relativePath.startsWith("scripts/") &&
      relativePath.endsWith(".test.ts") &&
      source.includes("fast-check"),
  )
    .flatMap((file) => inspectPropertySpawns(file))
    .toSorted();

// Root tooling tests also exercise properties, outside workspace runners.
const collectViolations = (): string[] =>
  PROPERTY_CANDIDATES.filter(
    ({ relativePath, source }) =>
      relativePath !== SELF_PATH && source.includes("fast-check"),
  )
    .flatMap((file) => inspectOnce(file).violations)
    .toSorted();

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
  test("every property runner call uses configured parameters", () => {
    expect(collectViolations()).toEqual([]);
  });

  test("no root tooling property predicate spawns a process", () => {
    expect(collectSpawningProperties()).toEqual([]);
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
    try {
      const violations: string[] = [];
      for (const [
        workspace,
        command,
      ] of await collectPropertyScriptCommands()) {
        if (workspace === "apps/api") {
          if (
            // The API generates the CLI and capability runtime modules it
            // imports first.
            !/^(?:bun --cwd=\.\.\/\.\.\/packages\/cli run codegen:runtime && )?(?:bun run generate:capability-runtime && )?bun scripts\/run-tests\.ts\s+--property(?:\s|$)/u.test(
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
        const selector = /\$\((grep\s[^)]+)\)/u.exec(command)?.at(1);
        // Accept the literal root operands and include flags used by the
        // manifests; unrelated test roots need not belong to this runner.
        const roots =
          selector === undefined
            ? undefined
            : /^grep\s+-rlE\s+'[^']+'\s+([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*(?:\s+[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)*)(?:\s+--include='[^']+')*$/u
                .exec(selector)
                ?.at(1)
                ?.split(/\s+/u);
        if (
          selector === undefined ||
          roots === undefined ||
          roots.length === 0
        ) {
          violations.push(
            `${workspace}: test:property has no recognized literal-root selector`,
          );
          continue;
        }
        for (const root of roots) {
          mkdirSync(path.join(fixtureRoot, root), { recursive: true });
          await Promise.all([
            Bun.write(
              path.join(fixtureRoot, root, "legacy.test.ts"),
              "fc.assert(property);",
            ),
            Bun.write(
              path.join(fixtureRoot, root, "shared.test.ts"),
              'assertProperty("shared", property);',
            ),
            Bun.write(
              path.join(fixtureRoot, root, "ordinary.test.ts"),
              'test("ordinary", () => {});',
            ),
          ]);
        }
        const expectedPaths = [...new Set(roots)]
          .flatMap((root) => [
            `${root}/legacy.test.ts`,
            `${root}/shared.test.ts`,
          ])
          .toSorted();
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
      collectPropertyTestFiles().map(({ relativePath }) =>
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
