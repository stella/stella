#!/usr/bin/env bun

import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "../packages/collation/src/collation";

const ROOT = path.resolve(import.meta.dirname, "..");
const DISABLED_LEDGER = "scripts/test-gate-disabled.json";
const NON_GATING_LEDGER = "scripts/test-gate-non-gating.json";
const SERVICE_GATES = [
  "STELLA_RUN_CORPUS_ENGINE_TESTS",
  "STELLA_RUN_POSTGRES_TESTS",
  "STELLA_RUN_VALKEY_TESTS",
] as const;
const TEST_REGISTRATIONS = [
  "afterAll",
  "afterEach",
  "beforeAll",
  "beforeEach",
  "describe",
  "it",
  "test",
] as const;

type DisabledLedger = {
  readonly managedServiceGates: readonly string[];
  readonly identities: readonly string[];
};

type NonGatingScenario = {
  readonly file: string;
  readonly owningWorkflow: string;
  readonly reason: string;
};

export type RegistrationFinding = {
  readonly identity: string;
  readonly managedServiceGate?: (typeof SERVICE_GATES)[number];
  readonly type: "disabled" | "only";
};

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, file), "utf-8"));

const stringArray = (value: unknown, label: string): readonly string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    panic(`${label} must be an array of strings`);
  }
  return value;
};

const readDisabledLedger = (): DisabledLedger => {
  const value = readJson(DISABLED_LEDGER);
  if (typeof value !== "object" || value === null) {
    panic(`${DISABLED_LEDGER} must be an object`);
  }
  if (!("managedServiceGates" in value) || !("identities" in value)) {
    panic(`${DISABLED_LEDGER} is missing required fields`);
  }
  return {
    managedServiceGates: stringArray(
      value.managedServiceGates,
      `${DISABLED_LEDGER}.managedServiceGates`,
    ),
    identities: stringArray(value.identities, `${DISABLED_LEDGER}.identities`),
  };
};

const readNonGatingLedger = (): readonly NonGatingScenario[] => {
  const value = readJson(NON_GATING_LEDGER);
  if (!Array.isArray(value)) {
    panic(`${NON_GATING_LEDGER} must be an array`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("file" in entry) ||
      typeof entry.file !== "string" ||
      !("owningWorkflow" in entry) ||
      typeof entry.owningWorkflow !== "string" ||
      !("reason" in entry) ||
      typeof entry.reason !== "string"
    ) {
      panic(`${NON_GATING_LEDGER} contains an invalid entry`);
    }
    return {
      file: entry.file,
      owningWorkflow: entry.owningWorkflow,
      reason: entry.reason,
    };
  });
};

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf-8" })
    .split("\0")
    .filter(Boolean)
    .toSorted(compareCodeUnit);

const propertyName = (node: ts.Node): string | undefined => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
    return node.text;
  }
  return undefined;
};

const registrationName = (
  expression: ts.Expression,
  aliases: ReadonlyMap<string, string>,
): string | undefined => {
  if (ts.isCallExpression(expression)) {
    return registrationName(expression.expression, aliases);
  }
  if (ts.isIdentifier(expression)) {
    return aliases.get(expression.text);
  }
  if (!ts.isPropertyAccessExpression(expression)) {
    return undefined;
  }
  const base = registrationName(expression.expression, aliases);
  return base === undefined ? undefined : `${base}.${expression.name.text}`;
};

const literalTitle = (node: ts.Node | undefined): string | undefined => {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
};

const containsEnvironmentReturn = (node: ts.Node): boolean => {
  let found = false;
  const containsEnvironment = (candidate: ts.Node): boolean =>
    candidate.getText().includes("process.env");
  const containsReturn = (candidate: ts.Node): boolean => {
    let result = false;
    const findReturn = (child: ts.Node): void => {
      if (ts.isReturnStatement(child)) {
        result = true;
      } else {
        ts.forEachChild(child, findReturn);
      }
    };
    findReturn(candidate);
    return result;
  };
  const visit = (child: ts.Node): void => {
    if (
      ts.isIfStatement(child) &&
      containsEnvironment(child.expression) &&
      containsReturn(child.thenStatement)
    ) {
      found = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

export const parseTestRegistrations = (
  file: string,
  sourceText: string,
): RegistrationFinding[] => {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const aliases = new Map<string, string>();
  for (const registration of TEST_REGISTRATIONS) {
    aliases.set(registration, registration === "it" ? "test" : registration);
  }

  const discoverAliases = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings !== undefined
    ) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (
            TEST_REGISTRATIONS.some((registration) => registration === imported)
          ) {
            aliases.set(
              element.name.text,
              imported === "it" ? "test" : imported,
            );
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const direct = registrationName(node.initializer, aliases);
      if (direct !== undefined) {
        aliases.set(node.name.text, direct);
      }
      if (ts.isConditionalExpression(node.initializer)) {
        const whenTrue = registrationName(node.initializer.whenTrue, aliases);
        const whenFalse = registrationName(node.initializer.whenFalse, aliases);
        if (whenTrue !== undefined && whenFalse !== undefined) {
          aliases.set(node.name.text, `${whenTrue}|conditional`);
        }
      }
    }
    ts.forEachChild(node, discoverAliases);
  };
  discoverAliases(source);

  const gateAliases = new Map<string, (typeof SERVICE_GATES)[number]>();
  const discoverGateAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = node.initializer.getText();
      const gate = SERVICE_GATES.find(
        (candidate) =>
          initializer.includes(candidate) ||
          [...gateAliases.entries()].some(
            ([alias, aliasedGate]) =>
              aliasedGate === candidate &&
              new RegExp(`\\b${alias}\\b`, "u").test(initializer),
          ),
      );
      if (gate !== undefined) {
        gateAliases.set(node.name.text, gate);
      }
    }
    ts.forEachChild(node, discoverGateAliases);
  };
  discoverGateAliases(source);

  const referencedServiceGate = (
    node: ts.Node,
  ): (typeof SERVICE_GATES)[number] | undefined => {
    const text = node.getText();
    return SERVICE_GATES.find(
      (gate) =>
        text.includes(gate) ||
        [...gateAliases.entries()].some(
          ([alias, aliasedGate]) =>
            aliasedGate === gate &&
            new RegExp(`\\b${alias}\\b`, "u").test(text),
        ),
    );
  };

  const findings: RegistrationFinding[] = [];
  const suites: string[] = [];
  const suiteGates: ((typeof SERVICE_GATES)[number] | undefined)[] = [];
  const isConditionallyRegistered = (node: ts.CallExpression): boolean => {
    let ancestor = node.parent;
    while (!ts.isSourceFile(ancestor)) {
      if (ts.isIfStatement(ancestor) || ts.isConditionalExpression(ancestor)) {
        return true;
      }
      if (ts.isFunctionLike(ancestor)) {
        return false;
      }
      ancestor = ancestor.parent;
    }
    return false;
  };
  const enclosingServiceGate = (
    node: ts.CallExpression,
  ): (typeof SERVICE_GATES)[number] | undefined => {
    let ancestor = node.parent;
    while (!ts.isSourceFile(ancestor)) {
      if (ts.isIfStatement(ancestor)) {
        return referencedServiceGate(ancestor.expression);
      }
      if (ts.isConditionalExpression(ancestor)) {
        return referencedServiceGate(ancestor.condition);
      }
      if (ts.isFunctionLike(ancestor)) {
        return undefined;
      }
      ancestor = ancestor.parent;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const name = registrationName(node.expression, aliases);
    const hook =
      name !== undefined && /^(?:after|before)(?:All|Each)$/u.test(name);
    const title = hook ? `hook:${name}` : literalTitle(node.arguments.at(0));
    if (name === undefined) {
      ts.forEachChild(node, visit);
      return;
    }
    const isOnly = name.split(".").includes("only");
    if (title === undefined) {
      if (isOnly) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        findings.push({
          identity: `${file}::<dynamic title at ${line + 1}:${character + 1}>`,
          type: "only",
        });
      }
      ts.forEachChild(node, visit);
      return;
    }
    const identity = `${file}::${[...suites, title].join(" > ")}`;
    const callback = node.arguments.at(-1);
    const managedServiceGate =
      referencedServiceGate(node.expression) ??
      (callback === undefined ? undefined : referencedServiceGate(callback)) ??
      enclosingServiceGate(node) ??
      suiteGates.at(-1);
    const isDisabled =
      name.includes("|conditional") ||
      isConditionallyRegistered(node) ||
      name
        .split(".")
        .some((part) =>
          ["skip", "todo", "skipIf", "todoIf", "if"].includes(part),
        ) ||
      (callback !== undefined && containsEnvironmentReturn(callback));
    if (isOnly) {
      findings.push({ identity, type: "only" });
    }
    if (isDisabled) {
      findings.push(
        managedServiceGate === undefined
          ? { identity, type: "disabled" }
          : { identity, managedServiceGate, type: "disabled" },
      );
    }

    if (name.startsWith("describe")) {
      suites.push(title);
      suiteGates.push(managedServiceGate);
      if (callback !== undefined) {
        ts.forEachChild(callback, visit);
      }
      suiteGates.pop();
      suites.pop();
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings.toSorted((left, right) =>
    compareCodeUnit(
      `${left.type}:${left.identity}`,
      `${right.type}:${right.identity}`,
    ),
  );
};

const nearestPackage = (file: string): string | undefined => {
  let directory = path.dirname(file);
  while (directory !== ".") {
    const candidate = path.join(ROOT, directory, "package.json");
    if (existsSync(candidate)) {
      return path.relative(ROOT, candidate);
    }
    directory = path.dirname(directory);
  }
  return undefined;
};

type PackageScripts = Readonly<Record<string, unknown>>;

const packageScripts = (packageFile: string): PackageScripts | undefined => {
  const parsed: unknown = readJson(packageFile);
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return undefined;
  }
  const scripts = parsed.scripts;
  return typeof scripts === "object" && scripts !== null ? scripts : undefined;
};

const shellWords = (command: string): string[] =>
  [
    ...command.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s;&|()]+)/gu),
  ].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

type PackageTestCollectionOptions = {
  readonly candidate: string;
  readonly packageDirectory: string;
  readonly scriptName?: string;
  readonly scripts: PackageScripts;
  readonly visited?: ReadonlySet<string>;
};

export const packageTestCollectionFailure = ({
  candidate,
  packageDirectory,
  scriptName = "test",
  scripts,
  visited = new Set(),
}: PackageTestCollectionOptions): string | undefined => {
  if (visited.has(scriptName)) {
    return `runner command: package script cycle at ${scriptName}`;
  }
  const command = scripts[scriptName];
  if (typeof command !== "string") {
    return `runner command: package script ${scriptName} is missing`;
  }
  const words = shellWords(command);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== "bun") {
      continue;
    }
    if (words[index + 1] === "run" && words[index + 2]?.startsWith("test:")) {
      return packageTestCollectionFailure({
        candidate,
        packageDirectory,
        scriptName: words[index + 2],
        scripts,
        visited: new Set([...visited, scriptName]),
      });
    }
    if (words[index + 1]?.endsWith("scripts/run-tests.ts")) {
      if (packageDirectory === "apps/api") {
        return ["src", "evals", "scripts"].some((root) =>
          candidate.startsWith(`${packageDirectory}/${root}/`),
        )
          ? undefined
          : "runner glob: API wrapper does not collect the file";
      }
      if (packageDirectory === "apps/web") {
        return /\.test\.[cm]?[jt]sx?$/u.test(candidate)
          ? undefined
          : "runner glob: web wrapper does not collect the file";
      }
      return "runner command: unrecognized test wrapper";
    }
    if (words[index + 1] !== "test") {
      continue;
    }
    const arguments_ = words.slice(index + 2);
    const ignorePatternIndex = arguments_.indexOf("--path-ignore-patterns");
    const relativeCandidate = path.posix.relative(packageDirectory, candidate);
    if (
      ignorePatternIndex !== -1 &&
      arguments_[ignorePatternIndex + 1] !== undefined &&
      new Bun.Glob(arguments_[ignorePatternIndex + 1]).match(relativeCandidate)
    ) {
      return "runner glob: test command excludes the file";
    }
    const positional = arguments_.filter(
      (argument, argumentIndex) =>
        !argument.startsWith("-") &&
        (ignorePatternIndex === -1 ||
          argumentIndex !== ignorePatternIndex + 1) &&
        argument !== "true" &&
        argument !== "false",
    );
    if (
      positional.length === 0 ||
      positional.some(
        (entry) =>
          relativeCandidate === entry ||
          relativeCandidate.startsWith(`${entry}/`) ||
          new Bun.Glob(entry).match(relativeCandidate),
      )
    ) {
      return undefined;
    }
    return "runner glob: test command does not collect the file";
  }
  return "runner command: test script does not invoke a test runner";
};

const isTypeScriptTest = (file: string): boolean =>
  /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file);

const isCollectedByGatingPlaywright = (
  file: string,
  packageFile: string,
  scripts: PackageScripts,
): boolean => {
  const parsed = readJson(packageFile);
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    return false;
  }
  const packageName = parsed.name;
  if (typeof packageName !== "string") {
    return false;
  }
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const packageDirectory = path.posix.dirname(packageFile);
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      typeof command !== "string" ||
      !command.includes("playwright test") ||
      (!workflow.includes(`--filter ${packageName} ${scriptName}`) &&
        !workflow.includes(
          `cd ${packageDirectory}\n          bun run ${scriptName}`,
        ))
    ) {
      continue;
    }
    const words = shellWords(command);
    const configFlag = words.findIndex(
      (word) => word === "--config" || word === "-c",
    );
    const configName =
      configFlag === -1 ? "playwright.config.ts" : words[configFlag + 1];
    if (configName === undefined) {
      continue;
    }
    const configFile = path.join(ROOT, packageDirectory, configName);
    if (!existsSync(configFile)) {
      continue;
    }
    const config = readFileSync(configFile, "utf-8");
    const testDir = /\btestDir:\s*["']([^"']+)["']/u.exec(config)?.at(1) ?? ".";
    const testMatch = /\btestMatch:\s*["']([^"']+)["']/u.exec(config)?.at(1);
    const relative = path.posix.relative(
      path.posix.normalize(path.posix.join(packageDirectory, testDir)),
      file,
    );
    if (
      !relative.startsWith("../") &&
      (testMatch === undefined || new Bun.Glob(testMatch).match(relative))
    ) {
      return true;
    }
  }
  return false;
};

const e2eRunnerDirectories = (): ReadonlySet<string> => {
  const directories = new Set<string>();
  const configs = trackedFiles().filter((file) =>
    /^apps\/web\/e2e\/playwright(?:\.[^.]+)?\.config\.ts$/u.test(file),
  );
  for (const config of configs) {
    const source = ts.createSourceFile(
      config,
      readFileSync(path.join(ROOT, config), "utf-8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "testDir" &&
        ts.isStringLiteral(node.initializer)
      ) {
        directories.add(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(config), node.initializer.text),
          ),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return directories;
};

export const firstCollectionFailure = (
  file: string,
  nonGatingFiles: ReadonlySet<string>,
  e2eDirectories: ReadonlySet<string> = e2eRunnerDirectories(),
): string | undefined => {
  if (nonGatingFiles.has(file)) {
    return undefined;
  }
  if (file.startsWith("scripts/") || file.startsWith(".oxlint-plugins/")) {
    return undefined;
  }
  if (file.startsWith("apps/web/e2e/") && file.includes(".spec.")) {
    const covered = [...e2eDirectories].some(
      (directory) => file.startsWith(`${directory}/`) || file === directory,
    );
    return covered
      ? undefined
      : "runner glob: no Playwright config testDir includes the file";
  }
  const packageFile = nearestPackage(file);
  if (packageFile === undefined) {
    return "package task: no owning package.json";
  }
  const scripts = packageScripts(packageFile);
  if (scripts === undefined || !("test" in scripts)) {
    return `package task: ${packageFile} has no test script`;
  }
  const collectionFailure = packageTestCollectionFailure({
    candidate: file,
    packageDirectory: path.posix.dirname(packageFile),
    scripts,
  });
  if (
    collectionFailure !== undefined &&
    isCollectedByGatingPlaywright(file, packageFile, scripts)
  ) {
    return undefined;
  }
  if (collectionFailure !== undefined) {
    const parsed = readJson(packageFile);
    if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
      const packageName = parsed.name;
      const workflow = readFileSync(
        path.join(ROOT, ".github/workflows/ci.yml"),
        "utf-8",
      );
      if (typeof packageName === "string") {
        for (const scriptName of Object.keys(scripts).toSorted(
          compareCodeUnit,
        )) {
          if (
            workflow.includes(`--filter ${packageName} ${scriptName}`) &&
            packageTestCollectionFailure({
              candidate: file,
              packageDirectory: path.posix.dirname(packageFile),
              scriptName,
              scripts,
            }) === undefined
          ) {
            return undefined;
          }
        }
      }
    }
  }
  return collectionFailure;
};

const validateCanonicalOrder = (
  values: readonly string[],
  label: string,
  errors: string[],
): void => {
  const canonical = values.toSorted(compareCodeUnit);
  if (JSON.stringify(values) !== JSON.stringify(canonical)) {
    errors.push(`${label} is not sorted by stable key`);
  }
};

const validateExecutionTopology = (errors: string[]): void => {
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf-8",
  );
  for (const event of ["pull_request:", "merge_group:"]) {
    if (!workflow.includes(event)) {
      errors.push(`job condition: ci.yml does not run for ${event}`);
    }
  }
  const collectors = [
    "ci-checks-rest",
    "ci-tests",
    "desktop-clippy",
    "e2e-production-shard",
    "e2e-vite-canary",
    "route-smoke",
    "service-suites",
  ];
  const resultStart = workflow.indexOf("  ci-result:");
  if (resultStart === -1) {
    errors.push("result aggregation: ci-result job is missing");
  } else {
    const resultJob = workflow.slice(resultStart);
    for (const collector of collectors) {
      if (!resultJob.includes(`${collector},`)) {
        errors.push(
          `result aggregation: ci-result does not consume ${collector}`,
        );
      }
    }
  }
  const requiredCommands = [
    "bun scripts/run-unlisted-script-tests.ts",
    "bun run test -- --concurrency=2",
    "bun scripts/test-gate.ts",
  ];
  for (const command of requiredCommands) {
    if (!workflow.includes(command)) {
      errors.push(`runner glob: ci.yml does not execute ${command}`);
    }
  }

  const apiPackage = readFileSync(
    path.join(ROOT, "apps/api/package.json"),
    "utf-8",
  );
  const gateCommands = {
    STELLA_RUN_CORPUS_ENGINE_TESTS: "bun scripts/run-corpus-engine-suites.ts",
    STELLA_RUN_POSTGRES_TESTS: "bun run test:postgres",
    STELLA_RUN_VALKEY_TESTS: "bun run test:valkey",
  } as const satisfies Record<(typeof SERVICE_GATES)[number], string>;
  for (const gate of SERVICE_GATES) {
    if (!apiPackage.includes(`"gate": "${gate}"`)) {
      errors.push(
        `package task: apps/api/package.json does not declare ${gate}`,
      );
    }
    if (!workflow.includes(gateCommands[gate])) {
      errors.push(`job condition: no gating job executes the ${gate} runner`);
    }
  }
};

const run = (): void => {
  const files = trackedFiles().filter(isTypeScriptTest);
  const disabledLedger = readDisabledLedger();
  const nonGating = readNonGatingLedger();
  const errors: string[] = [];
  validateExecutionTopology(errors);
  validateCanonicalOrder(disabledLedger.identities, DISABLED_LEDGER, errors);
  validateCanonicalOrder(
    disabledLedger.managedServiceGates,
    `${DISABLED_LEDGER} managed gates`,
    errors,
  );
  validateCanonicalOrder(
    nonGating.map(({ file }) => file),
    NON_GATING_LEDGER,
    errors,
  );
  const nonGatingFiles = new Set(nonGating.map(({ file }) => file));
  const e2eDirectories = e2eRunnerDirectories();
  for (const scenario of nonGating) {
    if (!files.includes(scenario.file)) {
      errors.push(`non-gating file is not tracked: ${scenario.file}`);
    }
  }
  for (const file of files) {
    const brokenEdge = firstCollectionFailure(
      file,
      nonGatingFiles,
      e2eDirectories,
    );
    if (brokenEdge !== undefined) {
      errors.push(`${file}: ${brokenEdge}`);
    }
  }

  const managedGates = new Set(disabledLedger.managedServiceGates);
  const actualDisabled: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(ROOT, file), "utf-8");
    for (const finding of parseTestRegistrations(file, source)) {
      if (finding.type === "only") {
        errors.push(`${finding.identity}: .only is forbidden`);
      } else if (
        finding.managedServiceGate === undefined ||
        !managedGates.has(finding.managedServiceGate)
      ) {
        actualDisabled.push(finding.identity);
      }
    }
  }
  const actual = [...new Set(actualDisabled)].toSorted(compareCodeUnit);
  const expected = disabledLedger.identities;
  for (const identity of actual) {
    if (!expected.includes(identity)) {
      errors.push(`${identity}: disabled state is not ledgered`);
    }
  }
  for (const identity of expected) {
    if (!actual.includes(identity)) {
      errors.push(`${identity}: stale disabled-state ledger entry`);
    }
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `Checked ${files.length} tracked test files; manifest derived in memory.`,
  );
};

if (import.meta.main) {
  run();
}
