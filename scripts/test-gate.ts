#!/usr/bin/env bun

import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { compareCodeUnit } from "../packages/collation/src/collation";
import {
  contextFromNested,
  definitelyFalse,
  evaluate,
} from "./github-expression";
import {
  TEST_JOB_SHARDS,
  shardPackages,
  workspacePackages,
} from "./test-shards";
import { flattenWorkflowSteps } from "./workflow-steps";

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
const TEST_RUNNER_MODULES = new Set(["@playwright/test", "bun:test"]);
const TEST_RUNNER_NAMESPACE = "<test runner namespace>";

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
  if (base === TEST_RUNNER_NAMESPACE) {
    const registration = expression.name.text;
    if (TEST_REGISTRATIONS.some((candidate) => candidate === registration)) {
      return registration === "it" ? "test" : registration;
    }
    return undefined;
  }
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const constantStringBindings = (
  source: ts.SourceFile,
): ReadonlyMap<string, string> => {
  const bindings = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const value = literalTitle(node.initializer);
      if (value !== undefined) {
        bindings.set(node.name.text, value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
};

const registrationTitle = (
  node: ts.Node | undefined,
  constants: ReadonlyMap<string, string>,
): string | undefined => {
  const literal = literalTitle(node);
  if (literal !== undefined) {
    return literal;
  }
  return node !== undefined && ts.isIdentifier(node)
    ? constants.get(node.text)
    : undefined;
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

const parseTypeScript = (file: string, sourceText: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const isTestRunnerNamespaceImport = (
  bindings: ts.NamedImportBindings,
  moduleSpecifier: ts.Expression,
): bindings is ts.NamespaceImport =>
  ts.isNamespaceImport(bindings) &&
  ts.isStringLiteral(moduleSpecifier) &&
  TEST_RUNNER_MODULES.has(moduleSpecifier.text);

export const parseTestRegistrations = (
  file: string,
  sourceText: string,
): RegistrationFinding[] => {
  const source = parseTypeScript(file, sourceText);
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
      } else if (isTestRunnerNamespaceImport(bindings, node.moduleSpecifier)) {
        aliases.set(bindings.name.text, TEST_RUNNER_NAMESPACE);
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

  const constantTitles = constantStringBindings(source);

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
    if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
      ts.forEachChild(node, visit);
      return;
    }
    const name = registrationName(node.expression, aliases);
    const hook =
      name !== undefined && /^(?:after|before)(?:All|Each)$/u.test(name);
    const title = hook
      ? `hook:${name}`
      : registrationTitle(node.arguments.at(0), constantTitles);
    if (name === undefined) {
      ts.forEachChild(node, visit);
      return;
    }
    const isOnly = name.split(".").includes("only");
    const callback = node.arguments.at(-1);
    const isDisabled =
      name.includes("|conditional") ||
      isConditionallyRegistered(node) ||
      name
        .split(".")
        .some((part) =>
          ["skip", "todo", "skipIf", "todoIf", "if"].includes(part),
        ) ||
      (callback !== undefined && containsEnvironmentReturn(callback));
    if (title === undefined) {
      if (isOnly || isDisabled) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        findings.push({
          identity: `${file}::<dynamic title at ${line + 1}:${character + 1}>`,
          type: isOnly ? "only" : "disabled",
        });
      }
      ts.forEachChild(node, visit);
      return;
    }
    const identity = `${file}::${[...suites, title].join(" > ")}`;
    const managedServiceGate =
      referencedServiceGate(node.expression) ?? enclosingServiceGate(node);
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
      if (callback !== undefined) {
        ts.forEachChild(callback, visit);
      }
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

type PackageTestExecutionOptions = {
  readonly gatingJobs: ReadonlyMap<string, readonly string[]>;
  readonly packageDirectory: string;
  readonly packageName: string;
  readonly scriptName?: string;
  readonly shardedPackages: ReadonlySet<string>;
};

type GatingCommandExecutionOptions = {
  readonly commandMatches: (command: string) => boolean;
  readonly gatingJobs: ReadonlyMap<string, readonly string[]>;
  readonly missingMessage: string;
};

const gatingCommandExecutionFailure = ({
  commandMatches,
  gatingJobs,
  missingMessage,
}: GatingCommandExecutionOptions): string | undefined =>
  [...gatingJobs.values()].some((commands) => commands.some(commandMatches))
    ? undefined
    : missingMessage;

export const packageTestExecutionFailure = ({
  gatingJobs,
  packageDirectory,
  packageName,
  scriptName = "test",
  shardedPackages,
}: PackageTestExecutionOptions): string | undefined => {
  const invokesPackageScript = (command: string): boolean => {
    const words = shellWords(command);
    for (let index = 0; index < words.length; index += 1) {
      if (
        words[index] === "bun" &&
        words[index + 1] === "--filter" &&
        words[index + 2] === packageName &&
        words[index + 3] === scriptName
      ) {
        return true;
      }
      if (words[index] !== "bun") {
        continue;
      }
      const cwdOffset = words[index + 1] === "run" ? 2 : 1;
      if (
        words[index + cwdOffset] === "--cwd" &&
        words[index + cwdOffset + 1] === packageDirectory &&
        words[index + cwdOffset + 2] === scriptName
      ) {
        return true;
      }
    }
    const packageDirectoryChange = words.findIndex(
      (word, index) => word === "cd" && words[index + 1] === packageDirectory,
    );
    return (
      packageDirectoryChange !== -1 &&
      words.some(
        (word, index) =>
          index > packageDirectoryChange &&
          word === "bun" &&
          words[index + 1] === "run" &&
          words[index + 2] === scriptName,
      )
    );
  };
  const directExecutionFailure = gatingCommandExecutionFailure({
    commandMatches: invokesPackageScript,
    gatingJobs,
    missingMessage: `job condition: no gating job executes ${packageName} ${scriptName}`,
  });
  if (directExecutionFailure === undefined) {
    return undefined;
  }
  const testJob = gatingJobs.get("ci-tests");
  if (
    scriptName === "test" &&
    shardedPackages.has(packageName) &&
    testJob?.some((command) =>
      command.includes("bun run test -- --concurrency=2"),
    ) === true &&
    testJob.some((command) => command.includes("bun scripts/test-scope.ts")) &&
    testJob.some((command) =>
      command.includes("bun scripts/test-shards.ts --filters"),
    )
  ) {
    return undefined;
  }
  return directExecutionFailure;
};

type ManagedServiceRunnerOptions = {
  readonly command: string;
  readonly gate: (typeof SERVICE_GATES)[number];
  readonly gatingJobs: ReadonlyMap<string, readonly string[]>;
};

export const managedServiceRunnerFailure = ({
  command,
  gate,
  gatingJobs,
}: ManagedServiceRunnerOptions): string | undefined =>
  gatingCommandExecutionFailure({
    commandMatches: (candidate) => candidate.includes(command),
    gatingJobs,
    missingMessage: `job condition: no gating job executes the ${gate} runner`,
  });

const packageScripts = (packageFile: string): PackageScripts | undefined => {
  const parsed: unknown = readJson(packageFile);
  if (!isRecord(parsed) || !("scripts" in parsed)) {
    return undefined;
  }
  const scripts = parsed["scripts"];
  return isRecord(scripts) ? scripts : undefined;
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
    const delegatedScript = words[index + 2];
    if (words[index + 1] === "run" && delegatedScript?.startsWith("test:")) {
      return packageTestCollectionFailure({
        candidate,
        packageDirectory,
        scriptName: delegatedScript,
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
      arguments_.at(ignorePatternIndex + 1) !== undefined &&
      new Bun.Glob(arguments_.at(ignorePatternIndex + 1) ?? "").match(
        relativeCandidate,
      )
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

const playwrightGlobMatches = (pattern: string, file: string): boolean => {
  const bunPattern = pattern.replace(
    /@\(([^)]+)\)/gu,
    (_match, alternatives) =>
      typeof alternatives === "string"
        ? `{${alternatives.replaceAll("|", ",")}}`
        : "",
  );
  return new Bun.Glob(bunPattern).match(file);
};

const GATING_EVENTS = ["pull_request", "merge_group"] as const;

const conditionExpression = (condition: string): string =>
  condition
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "")
    .trim();

const gatingEventContext = (eventName: (typeof GATING_EVENTS)[number]) =>
  contextFromNested({
    github: {
      event: {
        pull_request: eventName === "pull_request" ? {} : null,
      },
      event_name: eventName,
    },
  });

const executableCondition = (
  condition: unknown,
  eventName: (typeof GATING_EVENTS)[number],
): boolean => {
  if (condition === undefined || condition === true) {
    return true;
  }
  if (condition === false || typeof condition !== "string") {
    return false;
  }
  const expression = conditionExpression(condition);
  if (definitelyFalse(expression, gatingEventContext(eventName))) {
    return false;
  }
  return (
    expression === "true" ||
    expression.includes("needs.ci-plan.outputs.") ||
    expression.includes("github.event_name") ||
    expression.includes("github.event.pull_request")
  );
};

const ignoresFailure = (
  continueOnError: unknown,
  eventName: (typeof GATING_EVENTS)[number],
): boolean => {
  if (continueOnError === true) {
    return true;
  }
  if (continueOnError === false || typeof continueOnError !== "string") {
    return false;
  }
  return (
    evaluate(
      conditionExpression(continueOnError),
      gatingEventContext(eventName),
    ) === true
  );
};

const workflowRecord = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const executableShell = (source: string): string =>
  source
    .split("\n")
    .map((line) => {
      let quote: "'" | '"' | undefined;
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\" && quote !== "'") {
          escaped = true;
          continue;
        }
        if (character === "'" || character === '"') {
          quote = quote === character ? undefined : (quote ?? character);
          continue;
        }
        if (
          character === "#" &&
          quote === undefined &&
          (index === 0 || /\s/u.test(line[index - 1] ?? ""))
        ) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");

export const gatingWorkflowJobs = (
  workflow: unknown,
): ReadonlyMap<string, readonly string[]> => {
  const root = workflowRecord(workflow);
  const jobs = workflowRecord(root?.["jobs"]);
  const resultJob = workflowRecord(jobs?.["ci-result"]);
  if (jobs === undefined || resultJob === undefined) {
    return new Map();
  }
  const needs = resultJob["needs"];
  let names: string[] = [];
  if (Array.isArray(needs)) {
    names = needs.filter((name): name is string => typeof name === "string");
  } else if (typeof needs === "string") {
    names = [needs];
  }
  if (names.length === 0) {
    return new Map();
  }
  const gating = new Map<string, readonly string[]>();
  for (const name of names) {
    const job = workflowRecord(jobs[name]);
    if (job === undefined) {
      continue;
    }
    if (!Array.isArray(job["steps"])) {
      continue;
    }
    const commands = flattenWorkflowSteps(job["steps"]).flatMap((step) => {
      if (typeof step["run"] !== "string") {
        return [];
      }
      const blocksMerge = GATING_EVENTS.some(
        (eventName) =>
          executableCondition(job["if"], eventName) &&
          executableCondition(step["if"], eventName) &&
          !ignoresFailure(job["continue-on-error"], eventName) &&
          !ignoresFailure(step["continue-on-error"], eventName),
      );
      return blocksMerge ? [executableShell(step["run"])] : [];
    });
    if (commands.length > 0) {
      gating.set(name, commands);
    }
  }
  return gating;
};

const repositoryTestExecutionTopology = (): {
  readonly gatingJobs: ReadonlyMap<string, readonly string[]>;
  readonly shardedPackages: ReadonlySet<string>;
} => {
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const packageNames = workspacePackages()
    .filter(({ hasTestScript }) => hasTestScript)
    .map(({ name }) => name);
  const gatingJobs = gatingWorkflowJobs(Bun.YAML.parse(workflow));
  const planJob = gatingJobs.get("ci-plan")?.join("\n") ?? "";
  return {
    gatingJobs,
    shardedPackages: new Set(
      Object.entries(TEST_JOB_SHARDS).flatMap(([jobShard, shards]) =>
        planJob.includes(`"${jobShard}"`)
          ? shards.flatMap((shard) => shardPackages({ packageNames, shard }))
          : [],
      ),
    ),
  };
};

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
  const gatingWorkflow = [
    ...gatingWorkflowJobs(Bun.YAML.parse(workflow)).values(),
  ]
    .flat()
    .join("\n");
  const packageDirectory = path.posix.dirname(packageFile);
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      typeof command !== "string" ||
      !command.includes("playwright test") ||
      (!gatingWorkflow.includes(`--filter ${packageName} ${scriptName}`) &&
        !gatingWorkflow.includes(
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
    const testDir = /\btestDir:\s*["']([^"']+)["']/u.exec(config)?.at(1);
    if (testDir === undefined) {
      continue;
    }
    const testMatch = /\btestMatch:\s*["']([^"']+)["']/u.exec(config)?.at(1);
    const testIgnore = /\btestIgnore:\s*["']([^"']+)["']/u.exec(config)?.at(1);
    const configDirectory = path.posix.dirname(
      path.posix.join(packageDirectory, configName),
    );
    const relative = path.posix.relative(
      path.posix.normalize(path.posix.join(configDirectory, testDir)),
      file,
    );
    if (
      !relative.startsWith("../") &&
      (testMatch === undefined || playwrightGlobMatches(testMatch, relative)) &&
      (testIgnore === undefined || !playwrightGlobMatches(testIgnore, relative))
    ) {
      return true;
    }
  }
  return false;
};

export const firstCollectionFailure = (
  file: string,
  nonGatingFiles: ReadonlySet<string>,
): string | undefined => {
  if (nonGatingFiles.has(file)) {
    return undefined;
  }
  if (file.startsWith("scripts/") || file.startsWith(".oxlint-plugins/")) {
    return undefined;
  }
  const packageFile = nearestPackage(file);
  if (packageFile === undefined) {
    return "package task: no owning package.json";
  }
  const scripts = packageScripts(packageFile);
  if (scripts === undefined || !("test" in scripts)) {
    return `package task: ${packageFile} has no test script`;
  }
  const manifest = readJson(packageFile);
  if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
    return `package task: ${packageFile} has no package name`;
  }
  const packageName = manifest["name"];
  const packageDirectory = path.posix.dirname(packageFile);
  const topology = repositoryTestExecutionTopology();
  const collectionFailure = packageTestCollectionFailure({
    candidate: file,
    packageDirectory,
    scripts,
  });
  if (collectionFailure === undefined) {
    return packageTestExecutionFailure({
      ...topology,
      packageDirectory,
      packageName,
    });
  }
  if (isCollectedByGatingPlaywright(file, packageFile, scripts)) {
    return undefined;
  }
  for (const scriptName of Object.keys(scripts).toSorted(compareCodeUnit)) {
    if (
      packageTestCollectionFailure({
        candidate: file,
        packageDirectory,
        scriptName,
        scripts,
      }) === undefined &&
      packageTestExecutionFailure({
        ...topology,
        packageDirectory,
        packageName,
        scriptName,
      }) === undefined
    ) {
      return undefined;
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
  const gatingJobs = gatingWorkflowJobs(Bun.YAML.parse(workflow));
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
    const runnerFailure = managedServiceRunnerFailure({
      command: gateCommands[gate],
      gate,
      gatingJobs,
    });
    if (runnerFailure !== undefined) {
      errors.push(runnerFailure);
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
  for (const scenario of nonGating) {
    if (!files.includes(scenario.file)) {
      errors.push(`non-gating file is not tracked: ${scenario.file}`);
    }
  }
  for (const file of files) {
    const brokenEdge = firstCollectionFailure(file, nonGatingFiles);
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
