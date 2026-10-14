#!/usr/bin/env bun

import { panic, Result } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import { compareCodeUnit } from "../packages/collation/src/collation";
import {
  contextFromNested,
  definitelyFalse,
  evaluate,
} from "./github-expression";
import { customLintTestCommand } from "./run-custom-lint-tests";
import { unlistedTests } from "./run-unlisted-script-tests";
import {
  registrationRunsWithService,
  requiredServiceEnvironment,
  serviceConditionEvaluator,
} from "./test-gate-service";
import {
  TEST_JOB_SHARDS,
  TEST_SHARD_IDS,
  shardPackages,
  workspacePackages,
} from "./test-shards";
import { flattenWorkflowSteps } from "./workflow-steps";

const ROOT = path.resolve(import.meta.dirname, "..");
const DISABLED_LEDGER = "scripts/test-gate-disabled.json";
const NON_GATING_LEDGER = "scripts/test-gate-non-gating.json";
const DEFAULT_ON_CONTEXTS = "scripts/test-gate-default-on.json";
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
const REGISTRATION_MODIFIERS = new Set([
  "concurrent",
  "each",
  "failing",
  "fixme",
  "if",
  "only",
  "parallel",
  "serial",
  "skip",
  "skipIf",
  "todo",
  "todoIf",
]);

type DisabledLedger = {
  readonly managedServiceGates: readonly string[];
  readonly identities: readonly string[];
};

type NonGatingScenario = {
  readonly file: string;
  readonly owningWorkflow: string;
  readonly reason: string;
};

type DefaultOnContext = {
  readonly context: string;
  readonly reason: string;
  readonly value: string | boolean;
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

const readDefaultOnContexts = (): readonly DefaultOnContext[] => {
  const value = readJson(DEFAULT_ON_CONTEXTS);
  if (!Array.isArray(value)) {
    panic(`${DEFAULT_ON_CONTEXTS} must be an array`);
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["context"] !== "string" ||
      !entry["context"].startsWith("vars.") ||
      typeof entry["reason"] !== "string" ||
      entry["reason"].trim() === "" ||
      (typeof entry["value"] !== "string" &&
        typeof entry["value"] !== "boolean")
    ) {
      panic(`${DEFAULT_ON_CONTEXTS} contains an invalid entry`);
    }
    return {
      context: entry["context"],
      reason: entry["reason"],
      value: entry["value"],
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
  if (base === TEST_RUNNER_NAMESPACE || base === "test") {
    const registration = expression.name.text;
    if (TEST_REGISTRATIONS.some((candidate) => candidate === registration)) {
      return registration === "it" ? "test" : registration;
    }
    if (base === TEST_RUNNER_NAMESPACE) {
      return undefined;
    }
  }
  return base === undefined || !REGISTRATION_MODIFIERS.has(expression.name.text)
    ? undefined
    : `${base}.${expression.name.text}`;
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

const serviceGateAliases = (source: ts.SourceFile) => {
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
  return gateAliases;
};

const referencedServiceGate = (
  node: ts.Node,
  gateAliases: ReturnType<typeof serviceGateAliases>,
): (typeof SERVICE_GATES)[number] | undefined => {
  const text = node.getText();
  return SERVICE_GATES.find(
    (gate) =>
      text.includes(gate) ||
      [...gateAliases.entries()].some(
        ([alias, aliasedGate]) =>
          aliasedGate === gate && new RegExp(`\\b${alias}\\b`, "u").test(text),
      ),
  );
};

const serviceEnvironments = new Map<string, ReadonlySet<string>>();
const serviceEnvironment = (
  gate: (typeof SERVICE_GATES)[number],
): ReadonlySet<string> => {
  const cached = serviceEnvironments.get(gate);
  if (cached !== undefined) {
    return cached;
  }
  const manifest = readJson("apps/api/package.json");
  if (!isRecord(manifest) || !isRecord(manifest["ciGateTestRunners"])) {
    panic("API service runners are missing");
  }
  const runner = Object.values(manifest["ciGateTestRunners"]).find(
    (value) => isRecord(value) && value["gate"] === gate,
  );
  if (
    !isRecord(runner) ||
    typeof runner["runner"] !== "string" ||
    runner["gateValue"] !== "true"
  ) {
    panic(`Service runner is missing for ${gate}`);
  }
  const file = path.posix.join("apps/api", runner["runner"]);
  const required = requiredServiceEnvironment(
    parseTypeScript(file, readFileSync(path.join(ROOT, file), "utf-8")),
  );
  serviceEnvironments.set(gate, required);
  return required;
};

const isConditionallyRegistered = (node: ts.CallExpression): boolean => {
  let child: ts.Node = node;
  let ancestor = node.parent;
  while (!ts.isSourceFile(ancestor)) {
    if (
      ts.isBinaryExpression(ancestor) &&
      ancestor.right === child &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(ancestor.operatorToken.kind)
    ) {
      return true;
    }
    if (ts.isIfStatement(ancestor) || ts.isConditionalExpression(ancestor)) {
      return true;
    }
    if (ts.isFunctionLike(ancestor)) {
      return false;
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return false;
};
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
          aliases.set(node.name.text, `${whenTrue}|${whenFalse}|conditional`);
        }
      }
    }
    ts.forEachChild(node, discoverAliases);
  };
  discoverAliases(source);

  const constantTitles = constantStringBindings(source);

  const gateAliases = serviceGateAliases(source);
  const serviceConditions = new Map(
    SERVICE_GATES.map((gate) => [
      gate,
      serviceConditionEvaluator({
        source,
        gate,
        requiredEnvironment: serviceEnvironment(gate),
      }),
    ]),
  );

  const findings: RegistrationFinding[] = [];
  const suites: string[] = [];
  const enclosingServiceGate = (
    node: ts.CallExpression,
  ): (typeof SERVICE_GATES)[number] | undefined => {
    let ancestor = node.parent;
    while (!ts.isSourceFile(ancestor)) {
      if (ts.isIfStatement(ancestor)) {
        return referencedServiceGate(ancestor.expression, gateAliases);
      }
      if (ts.isConditionalExpression(ancestor)) {
        return referencedServiceGate(ancestor.condition, gateAliases);
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
    if (
      (ts.isCallExpression(node.parent) ||
        ts.isPropertyAccessExpression(node.parent)) &&
      node.parent.expression === node
    ) {
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
    const isOnly = name.split(/[.|]/u).includes("only");
    const callback = node.arguments.find(
      (argument, index) =>
        (hook || index > 0) &&
        (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)),
    );
    const calleeDisabled =
      name.includes("|conditional") ||
      name
        .split(".")
        .some((part) =>
          ["skip", "todo", "fixme", "skipIf", "todoIf", "if"].includes(part),
        );
    const callbackDisabled =
      callback !== undefined && containsEnvironmentReturn(callback);
    const isDisabled =
      calleeDisabled || callbackDisabled || isConditionallyRegistered(node);
    const unconditionallyDisabled = name
      .split(".")
      .some((part) => ["skip", "todo", "fixme"].includes(part));
    const controlledGate = calleeDisabled
      ? referencedServiceGate(node.expression, gateAliases)
      : enclosingServiceGate(node);
    const managedServiceGate =
      unconditionallyDisabled ||
      callbackDisabled ||
      controlledGate === undefined ||
      !registrationRunsWithService(
        node,
        serviceConditions.get(controlledGate) ??
          panic(`Service condition evaluator is missing for ${controlledGate}`),
      )
        ? undefined
        : controlledGate;
    if (title === undefined) {
      if (isOnly || isDisabled) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        findings.push({
          identity: `${file}::<dynamic title at ${line + 1}:${character + 1}>`,
          ...(managedServiceGate === undefined ? {} : { managedServiceGate }),
          type: isOnly ? "only" : "disabled",
        });
      }
      ts.forEachChild(node, visit);
      return;
    }
    const identity = `${file}::${[...suites, title].join(" > ")}`;
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
      return repoRelativePath(ROOT, candidate);
    }
    directory = path.dirname(directory);
  }
  return undefined;
};

type PackageScripts = Readonly<Record<string, unknown>>;

type PackageTestExecutionOptions = {
  readonly rootScripts?: PackageScripts;
  readonly collection?: {
    readonly candidate: string;
    readonly scripts: PackageScripts;
  };
  readonly gatingJobs: ReadonlyMap<string, readonly GatingCommand[]>;
  readonly packageDirectory: string;
  readonly packageName: string;
  readonly scriptName?: string;
  readonly shardedPackages: ReadonlySet<string>;
};

type GatingCommandExecutionOptions = {
  readonly commandMatches: (command: GatingCommand) => boolean;
  readonly gatingJobs: ReadonlyMap<string, readonly GatingCommand[]>;
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

// Workflow steps run under `bash -eo pipefail`. Package scripts run with
// neither errexit nor pipefail: only the last statement sets their status, and
// a runner piped into another command cannot fail them.
type ShellPropagation = {
  readonly pipefail: boolean;
  readonly errexit: boolean;
};

type GatingCommand = {
  readonly command: string;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly propagation: ShellPropagation;
};

const PACKAGE_SCRIPT_PROPAGATION: ShellPropagation = {
  pipefail: false,
  errexit: false,
};

type ShellInvocation = {
  readonly words: readonly string[];
  readonly tokens: readonly ShellToken[];
  readonly index: number;
};

type ShellInvocationGatesOptions = {
  readonly command: string;
  readonly matches: (invocation: ShellInvocation) => boolean;
  readonly propagation?: ShellPropagation;
  readonly knownRunner?: (invocation: ShellInvocation) => boolean;
  readonly onUnresolved?: (reason: string) => void;
};

const literalShellWord = (word: string) =>
  !word.includes("$") && !word.includes("`");
const SHELL_SAFE_PREFIXES = new Map<
  string,
  (args: readonly string[]) => boolean
>([
  ["true", (args) => args.length === 0],
  [":", (args) => args.every(literalShellWord)],
  ["cd", (args) => args.length === 1 && args.every(literalShellWord)],
  [
    "export",
    (args) =>
      args.length > 0 &&
      args.every(
        (arg) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg) && literalShellWord(arg),
      ),
  ],
  [
    "set",
    (args) =>
      [
        "-e",
        "-o pipefail",
        "-e -o pipefail",
        "-eo pipefail",
        "-euo pipefail",
      ].includes(args.join(" ")),
  ],
]);

const directTestRunner = ({ words, index }: ShellInvocation) =>
  (words[index] === "bun" &&
    (words[index + 1] === "test" ||
      [
        "scripts/run-tests.ts",
        "scripts/run-unlisted-script-tests.ts",
        "scripts/run-custom-lint-tests.ts",
      ].some((script) => words[index + 1]?.endsWith(script)))) ||
  (words[index] === "playwright" && words[index + 1] === "test");

const SHELL_COMPOUND_ENDS = new Map([
  ["if", "fi"],
  ["case", "esac"],
  ["while", "done"],
  ["until", "done"],
  ["for", "done"],
  ["select", "done"],
  ["(", ")"],
  ["{", "}"],
]);

const SHELL_CONTEXT_MUTATORS = new Set([
  "shopt",
  "trap",
  "eval",
  "source",
  ".",
  "exec",
  "return",
  "command",
  "builtin",
  "enable",
]);

const unsafeFallbackToken = ({ role, value }: ShellToken): boolean =>
  (role === "operator" && ![";", "\n", "}"].includes(value)) ||
  (role === "command" && SHELL_CONTEXT_MUTATORS.has(value));

const simpleCommandPosition = (
  tokens: readonly ShellToken[],
  index: number,
): boolean => {
  const scopes: string[] = [];
  for (const token of tokens.slice(0, index)) {
    if (token.role !== "operator") {
      continue;
    }
    const end = SHELL_COMPOUND_ENDS.get(token.value);
    if (end !== undefined) {
      scopes.push(end);
    } else if (token.value === scopes.at(-1)) {
      scopes.pop();
    }
  }
  return scopes.length === 0;
};

const shellSafetyMutation = (
  tokens: readonly ShellToken[],
  index: number,
): string | undefined => {
  for (let cursor = 0; cursor < index; cursor += 1) {
    const token = tokens[cursor];
    if (token?.role !== "command") {
      continue;
    }
    if (SHELL_CONTEXT_MUTATORS.has(token.value)) {
      return `shell condition: unsupported shell mutation ${token.value}`;
    }
    if (
      token.value === "function" ||
      (tokens[cursor + 1]?.value === "(" && tokens[cursor + 2]?.value === ")")
    ) {
      return "shell condition: function definitions are unsupported";
    }
    if (token.value === "false") {
      return "shell condition: preceding false command does not establish execution";
    }
    const args = shellCommandSpan(tokens, cursor + 1).words;
    if (
      ["exit", "return"].includes(token.value) &&
      !literalFailureStatus(args.at(0))
    ) {
      return "shell condition: preceding exit or return can skip the runner";
    }
    if (token.value !== "set") {
      continue;
    }
    if (args.some((arg) => !literalShellWord(arg))) {
      return "shell condition: unresolved shell settings";
    }
    if (
      args.some(
        (arg, offset) =>
          (arg.startsWith("+") &&
            arg.includes("e") &&
            /^[a-z]+$/u.test(arg.slice(1))) ||
          (/^\+[a-z]*o$/u.test(arg) &&
            ["errexit", "pipefail"].includes(args[offset + 1] ?? "")),
      )
    ) {
      return "shell condition: shell failure propagation was disabled before the runner";
    }
  }
  return undefined;
};

// Shell exit statuses wrap modulo 256; accept canonical nonzero bytes.
const literalFailureStatus = (status: string | undefined): boolean =>
  status !== undefined && /^[1-9]\d*$/u.test(status) && Number(status) <= 255;

const separatorToken = (token: ShellToken | undefined): boolean =>
  token?.role === "operator" && [";", "\n"].includes(token.value);

const simplePrefixIsSafe = (
  tokens: readonly ShellToken[],
  knownRunner: (invocation: ShellInvocation) => boolean,
): boolean => {
  if (tokens.some((token) => token.role === "operator")) {
    return false;
  }
  const commands = tokens.flatMap((token, index) =>
    token.role === "command" ? [index] : [],
  );
  if (commands.length === 0) {
    return (
      tokens.length > 0 &&
      tokens.every(
        (token) => token.role === "assignment" && literalShellWord(token.value),
      )
    );
  }
  if (
    tokens.some(
      (token) => token.role === "assignment" && !literalShellWord(token.value),
    )
  ) {
    return false;
  }
  const words = tokens.map(({ value }) => value);
  return commands.some((index) => {
    const value = tokens[index]?.value;
    return (
      value !== undefined &&
      (SHELL_SAFE_PREFIXES.get(value)?.(
        shellCommandSpan(tokens, index + 1).words,
      ) === true ||
        knownRunner({ tokens, words, index }))
    );
  });
};

const shellPrefixFailure = (
  tokens: readonly ShellToken[],
  index: number,
  knownRunner: (invocation: ShellInvocation) => boolean,
): string | undefined => {
  let start = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const token = tokens[cursor];
    if (separatorToken(token)) {
      const previous = tokens[cursor - 1];
      if (
        token?.value === "\n" &&
        previous?.role === "operator" &&
        ["&&", "||", "|"].includes(previous.value)
      ) {
        continue;
      }
      start = cursor + 1;
    }
  }
  let segmentStart = start;
  for (let cursor = start; cursor < index; cursor += 1) {
    const token = tokens[cursor];
    if (token?.role !== "operator") {
      continue;
    }
    if (token.value === "||") {
      return "shell condition: runner is reached through an unsupported fallback";
    }
    if (token.value !== "&&") {
      continue;
    }
    if (!simplePrefixIsSafe(tokens.slice(segmentStart, cursor), knownRunner)) {
      return "shell condition: unresolved prefix before && does not guarantee execution";
    }
    segmentStart = cursor + 1;
  }
  return undefined;
};

const approvedFailureFallbackEnd = (
  tokens: readonly ShellToken[],
  start: number,
): number | undefined => {
  let cursor = start;
  while (
    tokens[cursor]?.role === "operator" &&
    tokens[cursor]?.value === "\n"
  ) {
    cursor += 1;
  }
  const grouped =
    tokens[cursor]?.role === "operator" && tokens[cursor]?.value === "{";
  if (grouped) {
    cursor += 1;
  }
  const bodyStart = cursor;
  for (; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token === undefined) {
      return undefined;
    }
    if (unsafeFallbackToken(token)) {
      return undefined;
    }
    if (token.role !== "command" || token.value !== "exit") {
      if (
        token.role === "operator" &&
        (token.value === "}" || (!grouped && separatorToken(token)))
      ) {
        return undefined;
      }
      continue;
    }
    if (!literalFailureStatus(tokens[cursor + 1]?.value)) {
      return undefined;
    }
    if (!grouped && cursor !== bodyStart) {
      return undefined;
    }
    let end = cursor + 2;
    if (grouped) {
      while (separatorToken(tokens[end])) {
        end += 1;
      }
      return tokens[end]?.role === "operator" && tokens[end]?.value === "}"
        ? end + 1
        : undefined;
    }
    return end === tokens.length || separatorToken(tokens[end])
      ? end
      : undefined;
  }
  return undefined;
};

type ApprovedInvocationOptions = {
  readonly tokens: readonly ShellToken[];
  readonly index: number;
  readonly propagation: ShellPropagation;
  readonly knownRunner: (invocation: ShellInvocation) => boolean;
};

const approvedInvocationFailure = ({
  tokens,
  index,
  propagation,
  knownRunner,
}: ApprovedInvocationOptions): string | undefined => {
  if (!simpleCommandPosition(tokens, index)) {
    return "shell condition: compound command bodies are unsupported";
  }
  const mutation = shellSafetyMutation(tokens, index);
  if (mutation !== undefined) {
    return mutation;
  }
  const prefix = shellPrefixFailure(tokens, index, knownRunner);
  if (prefix !== undefined) {
    return prefix;
  }
  let chained = false;
  let hasFallback = false;
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token?.role !== "operator") {
      continue;
    }
    if (token.value === "&") {
      return "shell condition: background execution cannot gate";
    }
    if (token.value === "|") {
      if (!propagation.pipefail) {
        return "shell condition: pipeline failure propagation is disabled";
      }
      continue;
    }
    if (token.value === "&&") {
      chained = true;
      continue;
    }
    if (token.value === "||") {
      if (chained) {
        return "shell condition: mixed short-circuit fallbacks are unsupported";
      }
      const end = approvedFailureFallbackEnd(tokens, cursor + 1);
      if (end === undefined) {
        return "shell condition: fallback must exit unconditionally with a literal failure status";
      }
      cursor = end - 1;
      hasFallback = true;
      continue;
    }
    if (separatorToken(token)) {
      const previous = tokens[cursor - 1];
      if (
        token.value === "\n" &&
        previous?.role === "operator" &&
        ["&&", "||", "|"].includes(previous.value)
      ) {
        continue;
      }
      const trailing = tokens
        .slice(cursor + 1)
        .some((item) => !separatorToken(item));
      const nextCommand = tokens
        .slice(cursor + 1)
        .find((item) => item.role === "command");
      if (
        trailing &&
        !hasFallback &&
        nextCommand !== undefined &&
        ["true", ":", "exit"].includes(nextCommand.value)
      ) {
        return "shell condition: later success statements can conceal the runner failure";
      }
      if (trailing && !hasFallback && (!propagation.errexit || chained)) {
        return "shell condition: later statements can conceal the runner failure";
      }
      return undefined;
    }
    return "shell condition: unsupported command shape after the runner";
  }
  return undefined;
};

const shellInvocationGates = ({
  command,
  matches,
  propagation = { errexit: true, pipefail: true },
  knownRunner,
  onUnresolved,
}: ShellInvocationGatesOptions): boolean => {
  const tokens = shellTokens(command.replaceAll(/\\\r?\n/gu, " "));
  const words = tokens.map(({ value }) => value);
  const recognizedRunner = (invocation: ShellInvocation) =>
    directTestRunner(invocation) ||
    matches(invocation) ||
    knownRunner?.(invocation) === true;
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index]?.role !== "command" ||
      !matches({ tokens, words, index })
    ) {
      continue;
    }
    const failure = approvedInvocationFailure({
      tokens,
      index,
      propagation,
      knownRunner: recognizedRunner,
    });
    if (failure === undefined) {
      return true;
    }
    onUnresolved?.(failure);
  }
  return false;
};

type PackageInvocationOptions = ShellInvocation & {
  readonly packageDirectory: string;
  readonly packageName: string;
  readonly scriptName: string;
  readonly propagation?: ShellPropagation;
};

const packageInvocationEnd = ({
  words,
  tokens,
  index,
  packageDirectory,
  packageName,
  scriptName,
  propagation,
}: PackageInvocationOptions): number | undefined => {
  if (words[index] !== "bun") {
    return undefined;
  }
  if (
    words[index + 1] === "--filter" &&
    words[index + 2] === packageName &&
    words[index + 3] === scriptName
  ) {
    return index + 4;
  }
  const cwdOffset = words[index + 1] === "run" ? 2 : 1;
  if (
    words[index + cwdOffset] === "--cwd" &&
    words[index + cwdOffset + 1] === packageDirectory &&
    words[index + cwdOffset + 2] === scriptName
  ) {
    return index + cwdOffset + 3;
  }
  // An adjacent directory change must succeed before this runner executes.
  // Workflow errexit also enforces that contract across statement separators.
  const preceding = tokens
    .slice(0, index)
    .filter(
      (token) => token.role !== "assignment" && token.role !== "redirect",
    );
  const separator = preceding.at(-1);
  const directory = preceding.at(-2);
  const changeDirectory = preceding.at(-3);
  const directoryPrefix = preceding.at(-4);
  if (
    words[index + 1] === "run" &&
    words[index + 2] === scriptName &&
    separator?.role === "operator" &&
    (separator.value === "&&" ||
      ((propagation?.errexit ?? true) &&
        (directoryPrefix === undefined ||
          (directoryPrefix.role === "operator" &&
            (directoryPrefix.value === "\n" ||
              directoryPrefix.value === ";"))) &&
        (separator.value === "\n" || separator.value === ";"))) &&
    directory?.role === "argument" &&
    directory.value === packageDirectory &&
    changeDirectory?.role === "command" &&
    changeDirectory.value === "cd"
  ) {
    return index + 3;
  }
  return undefined;
};

type GatingArgumentsOptions = {
  readonly command: string;
  readonly invocationEnd: (invocation: ShellInvocation) => number | undefined;
  readonly onUnresolved?: (reason: string) => void;
  readonly propagation?: ShellPropagation;
};

const gatingArguments = ({
  command,
  invocationEnd,
  propagation,
  onUnresolved,
}: GatingArgumentsOptions): readonly string[][] => {
  const tokens = shellTokens(command.replaceAll(/\\\r?\n/gu, " "));
  const words = tokens.map(({ value }) => value);
  const invocations: string[][] = [];
  for (let index = 0; index < words.length; index += 1) {
    const end = invocationEnd({ words, tokens, index });
    if (
      end === undefined ||
      !shellInvocationGates({
        command,
        matches: ({ index: cursor }) => cursor === index,
        ...(propagation === undefined ? {} : { propagation }),
        ...(onUnresolved === undefined ? {} : { onUnresolved }),
      })
    ) {
      continue;
    }
    invocations.push(shellCommandSpan(tokens, end).words);
  }
  return invocations;
};

let cachedRootScripts: PackageScripts | undefined;
const repositoryRootScripts = (): PackageScripts => {
  cachedRootScripts ??= packageScripts("package.json") ?? {};
  return cachedRootScripts;
};

// A root script body runs as a package script, not under the workflow shell.
type RootCommand = {
  readonly command: string;
  readonly packageScript: boolean;
  readonly propagation: ShellPropagation;
};

type RootScriptExpansionOptions = {
  readonly command: string;
  readonly scripts: PackageScripts;
  readonly propagation: ShellPropagation;
  readonly visited?: ReadonlySet<string>;
};

const expandRootScripts = ({
  command,
  scripts,
  propagation,
  visited = new Set(),
}: RootScriptExpansionOptions): RootCommand[] => {
  const packageScript = visited.size > 0;
  const expanded: RootCommand[] = [{ command, packageScript, propagation }];
  const commandWords = shellWords(command, "include");
  const invokedNames = new Set(
    commandWords.flatMap((word, index) => {
      const name = commandWords[index + 2];
      return word === "bun" &&
        commandWords[index + 1] === "run" &&
        name !== undefined
        ? [name]
        : [];
    }),
  );
  for (const name of invokedNames) {
    const body = scripts[name];
    if (typeof body !== "string" || visited.has(name)) {
      continue;
    }
    const invocations = gatingArguments({
      command,
      invocationEnd: ({ words, tokens, index }) =>
        words[index] === "bun" &&
        words[index + 1] === "run" &&
        words[index + 2] === name &&
        !tokens
          .slice(0, index)
          .some((token) => token.role === "command" && token.value === "cd")
          ? index + 3
          : undefined,
      propagation: packageScript ? PACKAGE_SCRIPT_PROPAGATION : propagation,
    });
    for (const arguments_ of invocations) {
      const forwarded =
        arguments_.at(0) === "--" ? arguments_.slice(1) : arguments_;
      expanded.push(
        ...expandRootScripts({
          command: `${body} ${forwarded.map((word) => JSON.stringify(word)).join(" ")}`,
          scripts,
          propagation: PACKAGE_SCRIPT_PROPAGATION,
          visited: new Set([...visited, name]),
        }),
      );
    }
  }
  return expanded;
};

const expandedRootCommands = new WeakMap<
  PackageScripts,
  Map<string, readonly RootCommand[]>
>();
const rootScriptCommands = (
  workflowCommand: GatingCommand,
  scripts: PackageScripts,
): readonly RootCommand[] => {
  let commands = expandedRootCommands.get(scripts);
  if (commands === undefined) {
    commands = new Map();
    expandedRootCommands.set(scripts, commands);
  }
  const cacheKey = `${workflowCommand.propagation.errexit}:${workflowCommand.propagation.pipefail}:${workflowCommand.command}`;
  const cached = commands.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const expanded = expandRootScripts({
    command: workflowCommand.command,
    scripts,
    propagation: workflowCommand.propagation,
  });
  commands.set(cacheKey, expanded);
  return expanded;
};

type TurboSelection =
  | { readonly type: "selected"; readonly forwarded: readonly string[] }
  | { readonly type: "not-selected" }
  | { readonly type: "unresolved"; readonly reason: string };

type ShardedSelectionOptions = {
  readonly arguments_: readonly string[];
  readonly run: GatingCommand;
  readonly packageName: string;
  readonly packageDirectory: string;
  readonly shardedPackages: ReadonlySet<string>;
};

type TurboFilterOptions = {
  readonly filter: string;
  readonly packageName: string;
  readonly packageDirectory: string;
};

const turboFilterMatches = ({
  filter,
  packageName,
  packageDirectory,
}: TurboFilterOptions): boolean => {
  const candidate = filter.startsWith("./") ? packageDirectory : packageName;
  return new Bun.Glob(filter.replace(/^\.\//u, "")).match(candidate);
};

const beforeWorkspaceTest = (command: string): string => {
  const lines = command.split("\n");
  const first = lines.findIndex((line) =>
    line.trimStart().startsWith("bun run test "),
  );
  return lines.slice(0, first === -1 ? 0 : first).join("\n");
};

const runtimeScopeArguments = (command: string): boolean => {
  const prefix = beforeWorkspaceTest(command);
  const lines = prefix.split("\n").map((line) => line.trim());
  return (
    lines.filter((line) => line.startsWith("args=")).join("") === "args=()" &&
    lines.filter((line) => line.startsWith("scope=")).join("") ===
      'scope=$(bun scripts/test-scope.ts --base "origin/$BASE_REF")' &&
    lines.filter((line) => line.startsWith("read -r -a args ")).join("") ===
      'read -r -a args <<<"$scope"' &&
    !lines.some((line) =>
      /\b(?:eval|source)\b|^\.\s|args\+=|args\[[^\]]+\]=/u.test(line),
    )
  );
};

const runtimeShardSelected = ({
  run,
  packageName,
  shardedPackages,
}: Omit<
  ShardedSelectionOptions,
  "arguments_" | "packageDirectory"
>): boolean => {
  const prefix = beforeWorkspaceTest(run.command);
  if (/\bSHARD(?:\+?=|\[)|\bunset\s+SHARD\b/u.test(prefix)) {
    return false;
  }
  const reads = prefix
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("read -r -a shard_args "));
  if (
    reads.join("") !==
      'read -r -a shard_args <<<"$(bun scripts/test-shards.ts --filters "$SHARD")"' ||
    /shard_args(?:\+?=|\[[^\]]+\]=)/u.test(prefix)
  ) {
    return false;
  }
  const raw = run.environment["SHARD"];
  if (typeof raw !== "string") {
    return false;
  }
  const values = raw.startsWith("${{")
    ? Object.keys(TEST_JOB_SHARDS).map((shard) =>
        evaluate(
          conditionExpression(raw),
          contextFromNested({ matrix: { shard } }),
        ),
      )
    : [raw];
  return values.some((value) => {
    const shard = TEST_SHARD_IDS.find((id) => id === value);
    return (
      shard !== undefined &&
      shardPackages({ packageNames: [...shardedPackages], shard }).includes(
        packageName,
      )
    );
  });
};

const shardedTestSelection = ({
  arguments_,
  run,
  packageName,
  packageDirectory,
  shardedPackages,
}: ShardedSelectionOptions): TurboSelection => {
  const positive: string[] = [];
  const negative: string[] = [];
  let forwarded: readonly string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--") {
      forwarded = arguments_.slice(index + 1);
      break;
    }
    if (/^--(?:dry(?:-run)?|graph)(?:=|$)/u.test(argument)) {
      return { type: "not-selected" };
    }
    if (
      ["--concurrency=2", "--output-logs=full", "--log-order=stream"].includes(
        argument,
      )
    ) {
      continue;
    }
    if (argument === `\${args[@]}`) {
      if (runtimeScopeArguments(run.command)) {
        continue;
      }
      return {
        type: "unresolved",
        reason: "runner selection: scope arguments have no recognized producer",
      };
    }
    if (argument === `\${shard_args[@]}`) {
      if (runtimeShardSelected({ run, packageName, shardedPackages })) {
        continue;
      }
      return { type: "not-selected" };
    }
    let filter: string | undefined;
    if (argument.startsWith("--filter=")) {
      filter = argument.slice("--filter=".length);
    }
    if (argument === "--filter") {
      index += 1;
      filter = arguments_[index];
    }
    if (
      filter === undefined ||
      filter.length === 0 ||
      /[$`[\]{}]|\.\.\./u.test(filter)
    ) {
      return {
        type: "unresolved",
        reason: `runner selection: unsupported Turbo argument ${argument}`,
      };
    }
    if (filter.startsWith("!")) {
      negative.push(filter.slice(1));
    } else {
      positive.push(filter);
    }
  }
  const matches = (filter: string) =>
    turboFilterMatches({ filter, packageName, packageDirectory });
  if (
    negative.some(matches) ||
    (positive.length > 0 && !positive.some(matches))
  ) {
    return { type: "not-selected" };
  }
  return { type: "selected", forwarded };
};

type ShardedExecutionOptions = ShardedSelectionOptions & {
  readonly rootScripts: PackageScripts;
  readonly collection: PackageTestExecutionOptions["collection"];
};

const shardedExecutionFailure = ({
  run,
  rootScripts,
  collection,
  packageName,
  packageDirectory,
  shardedPackages,
}: Omit<ShardedExecutionOptions, "arguments_">): string | undefined => {
  if (rootScripts["test"] !== "turbo run test") {
    return "runner command: root test script is not the workspace test task";
  }
  const invocations = gatingArguments({
    command: run.command,
    propagation: run.propagation,
    invocationEnd: ({ words, index }) =>
      words[index] === "bun" &&
      words[index + 1] === "run" &&
      words[index + 2] === "test" &&
      words[index + 3] === "--"
        ? index + 4
        : undefined,
  });
  let failure =
    "runner selection: workspace test command does not select the package";
  for (const arguments_ of invocations) {
    const selection = shardedTestSelection({
      arguments_,
      run,
      packageName,
      packageDirectory,
      shardedPackages,
    });
    if (selection.type === "not-selected") {
      continue;
    }
    if (selection.type === "unresolved") {
      failure = selection.reason;
      continue;
    }
    if (collection === undefined) {
      return undefined;
    }
    const collectionFailure = packageTestCollectionFailure({
      ...collection,
      packageDirectory,
      forwardedArguments: selection.forwarded,
    });
    if (collectionFailure === undefined) {
      return undefined;
    }
    failure = collectionFailure;
  }
  return failure;
};

export const packageTestExecutionFailure = ({
  collection,
  rootScripts = repositoryRootScripts(),
  gatingJobs,
  packageDirectory,
  packageName,
  scriptName = "test",
  shardedPackages,
}: PackageTestExecutionOptions): string | undefined => {
  let directExecutionFailure = `job condition: no gating job executes ${packageName} ${scriptName}`;
  for (const commands of gatingJobs.values()) {
    for (const { command, packageScript, propagation } of commands.flatMap(
      (workflowCommand) => rootScriptCommands(workflowCommand, rootScripts),
    )) {
      const conditions: string[] = [];
      const invocations = gatingArguments({
        command,
        ...(!packageScript ? { propagation } : {}),
        onUnresolved: (reason) => {
          conditions.push(reason);
        },
        invocationEnd: ({ words, tokens, index }) =>
          packageInvocationEnd({
            words,
            tokens,
            index,
            packageDirectory,
            packageName,
            scriptName,
            ...(packageScript
              ? { propagation: PACKAGE_SCRIPT_PROPAGATION }
              : {}),
          }),
        ...(packageScript ? { propagation: PACKAGE_SCRIPT_PROPAGATION } : {}),
      });
      const condition = conditions.at(0);
      if (condition !== undefined) {
        directExecutionFailure += `; ${condition}`;
      }
      for (const arguments_ of invocations) {
        if (collection === undefined) {
          return undefined;
        }
        const failure = packageTestCollectionFailure({
          ...collection,
          packageDirectory,
          scriptName,
          forwardedArguments:
            arguments_.at(0) === "--" ? arguments_.slice(1) : arguments_,
        });
        if (failure === undefined) {
          return undefined;
        }
        directExecutionFailure = `${failure}; command: ${command}`;
      }
    }
  }
  const testJob = gatingJobs.get("ci-tests");
  if (scriptName === "test" && shardedPackages.has(packageName)) {
    for (const run of testJob ?? []) {
      const failure = shardedExecutionFailure({
        run,
        rootScripts,
        collection,
        packageName,
        packageDirectory,
        shardedPackages,
      });
      if (failure === undefined) {
        return undefined;
      }
      directExecutionFailure = failure;
    }
  }
  return directExecutionFailure;
};

type ManagedServiceRunnerOptions = {
  readonly command: string;
  readonly gate: (typeof SERVICE_GATES)[number];
  readonly gatingJobs: ReadonlyMap<string, readonly GatingCommand[]>;
};

export const managedServiceRunnerFailure = ({
  command,
  gate,
  gatingJobs,
}: ManagedServiceRunnerOptions): string | undefined => {
  const runner = shellWords(command);
  let condition: string | undefined;
  const failure = gatingCommandExecutionFailure({
    commandMatches: ({ command: candidate, propagation }) =>
      shellInvocationGates({
        command: candidate,
        propagation,
        onUnresolved: (reason) => {
          condition ??= reason;
        },
        matches: ({ words, index }) =>
          runner.every((word, offset) => words[index + offset] === word),
      }),
    gatingJobs,
    missingMessage: `job condition: no gating job executes the ${gate} runner`,
  });
  return failure !== undefined && condition !== undefined
    ? `${failure}; ${condition}`
    : failure;
};

type RootCommandOptions = {
  readonly command: string;
  readonly gatingJobs: ReadonlyMap<string, readonly GatingCommand[]>;
};

/** A required root collector counts only when a gating step runs it and its failure propagates. */
export const rootCommandExecutionFailure = ({
  command,
  gatingJobs,
}: RootCommandOptions): string | undefined => {
  const runner = shellWords(command);
  let condition: string | undefined;
  const failure = gatingCommandExecutionFailure({
    commandMatches: ({ command: candidate, propagation }) =>
      shellInvocationGates({
        command: candidate,
        propagation,
        onUnresolved: (reason) => {
          condition ??= reason;
        },
        matches: ({ words, index }) =>
          runner.every((word, offset) => words[index + offset] === word),
      }),
    gatingJobs,
    missingMessage: `job condition: no gating job executes ${command}`,
  });
  return failure !== undefined && condition !== undefined
    ? `${failure}; ${condition}`
    : failure;
};

const packageScripts = (packageFile: string): PackageScripts | undefined => {
  const parsed: unknown = readJson(packageFile);
  if (!isRecord(parsed) || !("scripts" in parsed)) {
    return undefined;
  }
  const scripts = parsed["scripts"];
  return isRecord(scripts) ? scripts : undefined;
};

type ShellToken = {
  readonly value: string;
  readonly role:
    | "command"
    | "argument"
    | "assignment"
    | "redirect"
    | "operator";
};

const shellCommandSpan = (tokens: readonly ShellToken[], start: number) => {
  const end = tokens.findIndex(
    (token, index) => index >= start && token.role === "operator",
  );
  const words = tokens
    .slice(start, end === -1 ? undefined : end)
    .flatMap(({ role, value }) =>
      role === "command" || role === "argument" ? [value] : [],
    );
  return { end, words };
};

const PLAYWRIGHT_IMAGE_WRAPPER =
  ".github/actions/setup-playwright/run-in-image.sh";

// This repository-owned wrapper forwards its command with exec, preserving
// its exit status. Preparation mode deliberately executes no child command.
const markImageWrapperCommands = (tokens: ShellToken[]): ShellToken[] => {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const script = tokens[index + 1];
    if (
      token?.role !== "command" ||
      token.value !== "bash" ||
      script?.role !== "argument"
    ) {
      continue;
    }
    const wrapper = script.value
      .replace(/^\$(?:GITHUB_WORKSPACE|\{GITHUB_WORKSPACE\})\//u, "")
      .replace(/^\.\//u, "");
    if (wrapper !== PLAYWRIGHT_IMAGE_WRAPPER) {
      continue;
    }
    const commandIndex =
      index + (tokens[index + 2]?.value === "--offline" ? 3 : 2);
    const command = tokens[commandIndex];
    if (command?.role !== "argument" || command.value.startsWith("-")) {
      continue;
    }
    tokens[commandIndex] = { value: command.value, role: "command" };
  }
  return tokens;
};

type TimeoutArgument = "duration" | "option-value" | "unresolved";

type TimeoutArgumentOptions = {
  readonly state: TimeoutArgument;
  readonly value: string;
};

const nextTimeoutArgument = ({
  state,
  value,
}: TimeoutArgumentOptions): TimeoutArgument | undefined => {
  switch (state) {
    case "option-value":
      return "duration";
    case "unresolved":
      return "unresolved";
    case "duration":
      if (["-k", "--kill-after", "-s", "--signal"].includes(value)) {
        return "option-value";
      }
      if (
        ["--", "--foreground", "--preserve-status", "-v", "--verbose"].includes(
          value,
        ) ||
        /^(?:--kill-after|--signal)=.+/u.test(value)
      ) {
        return "duration";
      }
      return /^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/u.test(value)
        ? undefined
        : "unresolved";
    default:
      state satisfies never;
      return panic("Unrecognized timeout argument state");
  }
};

// Preserve syntax roles: quoted operators and heredoc bodies are data, and
// only the first non-assignment word of a simple command is executable.
const shellTokens = (command: string): ShellToken[] => {
  // Sticky matching consumes whitespace explicitly and prevents restarting
  // the numeric redirection prefix at every digit of a malformed word.
  const pattern =
    /(#.*)|(\d*(?:<<<|<<-?|[<>]&|>>?|<)|\|\||&&|[;&|()\n])|((?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\\[^\n]|[^\s;&|()<>"'\\])+)|([^\S\n]+)/uy;
  const tokens: ShellToken[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let commandPosition = true;
  let redirect: string | undefined;
  let timeoutArgument: TimeoutArgument | undefined;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(command)) !== null) {
    consumed = pattern.lastIndex;
    if (match[4] !== undefined) {
      continue;
    }
    if (match[1] !== undefined) {
      continue;
    }
    const operator = match[2];
    if (operator !== undefined) {
      if (/[<>]/u.test(operator)) {
        tokens.push({ value: operator, role: "redirect" });
        redirect = operator.replace(/^\d+/u, "");
        continue;
      }
      tokens.push({ value: operator, role: "operator" });
      commandPosition = true;
      redirect = undefined;
      timeoutArgument = undefined;
      if (operator === "\n") {
        for (const { delimiter, stripTabs } of heredocs) {
          let found = false;
          while (pattern.lastIndex < command.length) {
            const start = pattern.lastIndex;
            const end = command.indexOf("\n", start);
            const line = command.slice(
              start,
              end === -1 ? command.length : end,
            );
            pattern.lastIndex = end === -1 ? command.length : end + 1;
            if (
              (stripTabs ? line.replace(/^\t+/u, "") : line).replace(
                /\r$/u,
                "",
              ) === delimiter
            ) {
              found = true;
              break;
            }
          }
          if (!found) {
            return tokens;
          }
        }
        heredocs.length = 0;
        consumed = pattern.lastIndex;
      }
      continue;
    }
    const raw = match[3] ?? panic("Shell token has neither syntax nor a word");
    const value = [
      ...raw.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^"']+)/gu),
    ]
      .map((part) => part[1] ?? part[2] ?? part[3] ?? "")
      .join("");
    if (redirect !== undefined) {
      tokens.push({ value, role: "redirect" });
      if (redirect === "<<" || redirect === "<<-") {
        heredocs.push({ delimiter: value, stripTabs: redirect === "<<-" });
      }
      redirect = undefined;
      continue;
    }
    if (timeoutArgument !== undefined) {
      tokens.push({ value, role: "argument" });
      timeoutArgument = nextTimeoutArgument({ state: timeoutArgument, value });
      commandPosition = timeoutArgument === undefined;
      continue;
    }
    if (
      commandPosition &&
      [
        "{",
        "}",
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "while",
        "until",
        "for",
        "select",
        "case",
        "do",
        "done",
        "esac",
      ].includes(raw)
    ) {
      tokens.push({ value, role: "operator" });
      commandPosition = true;
      continue;
    }
    if (commandPosition && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(raw)) {
      tokens.push({ value, role: "assignment" });
      continue;
    }
    tokens.push({ value, role: commandPosition ? "command" : "argument" });
    if (commandPosition && value === "timeout") {
      timeoutArgument = "duration";
    }
    commandPosition = false;
  }
  return command.slice(consumed).trim() === ""
    ? markImageWrapperCommands(tokens)
    : [];
};

const shellWords = (
  command: string,
  operators: "include" | "omit" = "omit",
): string[] =>
  shellTokens(command).flatMap(({ role, value }) =>
    role === "operator" && operators === "omit" ? [] : [value],
  );

const BUN_VALUE_ARGUMENTS = new Set([
  "--preload",
  "-r",
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--max-concurrency",
  "--reporter",
  "--reporter-outfile",
  "--coverage-dir",
  "--coverage-reporter",
  "--path-ignore-patterns",
  "--timings",
]);
const BUN_BOOLEAN_ARGUMENTS = new Set([
  "--coverage",
  "--concurrent",
  "--randomize",
  "--update-snapshots",
  "-u",
  "--dots",
  "--parallel",
  "--update-timings",
  "--todo",
]);

const bunArgumentCollectionFailure = (
  relativeCandidate: string,
  arguments_: readonly string[],
): string | undefined => {
  if (arguments_.some((argument) => /[$`]/u.test(argument))) {
    return "runner arguments: unresolved dynamic pass-through";
  }
  const patterns: string[] = [];
  const ignored: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--" && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !argument.startsWith("-")) {
      patterns.push(argument);
      continue;
    }
    const [flag, inlineValue] = argument.split(/[=](.*)/u);
    if (flag === "--bail") {
      if (
        inlineValue === undefined &&
        /^\d+$/u.test(arguments_[index + 1] ?? "")
      ) {
        index += 1;
      }
      continue;
    }
    if (BUN_BOOLEAN_ARGUMENTS.has(flag ?? "")) {
      continue;
    }
    if (!BUN_VALUE_ARGUMENTS.has(flag ?? "")) {
      return `runner arguments: unresolved option ${argument}`;
    }
    const value = inlineValue ?? arguments_[++index];
    if (value === undefined) {
      return `runner arguments: missing value for ${argument}`;
    }
    if (flag === "--path-ignore-patterns") {
      ignored.push(value);
    }
  }
  if (
    ignored.some((pattern) => new Bun.Glob(pattern).match(relativeCandidate))
  ) {
    return "runner glob: test command excludes the file";
  }
  if (
    patterns.length === 0 ||
    patterns.some((pattern) =>
      pattern.startsWith("./")
        ? relativeCandidate === path.posix.normalize(pattern) ||
          relativeCandidate.startsWith(`${path.posix.normalize(pattern)}/`)
        : !pattern.startsWith("/") && relativeCandidate.includes(pattern),
    )
  ) {
    return undefined;
  }
  return "runner glob: test command does not collect the file";
};

type PackageTestCollectionOptions = {
  readonly forwardedArguments?: readonly string[];
  readonly candidate: string;
  readonly packageDirectory: string;
  readonly scriptName?: string;
  readonly scripts: PackageScripts;
  readonly visited?: ReadonlySet<string>;
};

const testWrapperCollectionFailure = (
  packageDirectory: string,
  candidate: string,
): string | undefined => {
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
};

type KnownPackageRunnerOptions = {
  readonly invocation: ShellInvocation;
  readonly scripts: PackageScripts;
  readonly visited: ReadonlySet<string>;
};

const knownPackageRunner = ({
  invocation,
  scripts,
  visited,
}: KnownPackageRunnerOptions): boolean => {
  if (directTestRunner(invocation)) {
    return true;
  }
  const { words, index } = invocation;
  const name = words[index + 2];
  if (
    words[index] !== "bun" ||
    words[index + 1] !== "run" ||
    name === undefined ||
    !name.startsWith("test:") ||
    visited.has(name)
  ) {
    return false;
  }
  const body = scripts[name];
  return (
    typeof body === "string" &&
    shellInvocationGates({
      command: body,
      propagation: PACKAGE_SCRIPT_PROPAGATION,
      matches: (child) =>
        knownPackageRunner({
          invocation: child,
          scripts,
          visited: new Set([...visited, name]),
        }),
    })
  );
};

const collectablePackageRunner = (words: readonly string[], index: number) =>
  words[index] === "bun" &&
  (words[index + 1] === "test" ||
    words[index + 1]?.endsWith("scripts/run-tests.ts") ||
    (words[index + 1] === "run" && words[index + 2]?.startsWith("test:")));

export const packageTestCollectionFailure = ({
  forwardedArguments = [],
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
  const normalizedCommand = command.replaceAll(/\\\r?\n/gu, " ");
  const tokens = shellTokens(normalizedCommand);
  const words = tokens.map(({ value }) => value);
  // Every gating runner in the script counts: the file is collected when any
  // of them collects it, and the first failure is reported only when none do.
  let firstFailure: string | undefined;
  const conditions: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (
      !collectablePackageRunner(words, index) ||
      !shellInvocationGates({
        command: normalizedCommand,
        matches: ({ index: cursor }) => cursor === index,
        propagation: PACKAGE_SCRIPT_PROPAGATION,
        knownRunner: (invocation) =>
          knownPackageRunner({
            invocation,
            scripts,
            visited: new Set([...visited, scriptName]),
          }),
        onUnresolved: (reason) => {
          conditions.push(`runner command: ${reason}`);
        },
      })
    ) {
      continue;
    }
    const delegatedScript = words[index + 2];
    if (words[index + 1] === "run" && delegatedScript?.startsWith("test:")) {
      const { words: delegatedArguments, end: boundary } = shellCommandSpan(
        tokens,
        index + 3,
      );
      const delegatedFailure = packageTestCollectionFailure({
        candidate,
        packageDirectory,
        scriptName: delegatedScript,
        scripts,
        forwardedArguments: [
          ...(delegatedArguments.at(0) === "--"
            ? delegatedArguments.slice(1)
            : delegatedArguments),
          ...(boundary === -1 ? forwardedArguments : []),
        ],
        visited: new Set([...visited, scriptName]),
      });
      if (delegatedFailure === undefined) {
        return undefined;
      }
      firstFailure ??= delegatedFailure;
      continue;
    }
    if (words[index + 1]?.endsWith("scripts/run-tests.ts")) {
      const { words: remaining, end: boundary } = shellCommandSpan(
        tokens,
        index + 2,
      );
      const failure = bunArgumentCollectionFailure(
        repoRelativePath(packageDirectory, candidate),
        [...remaining, ...(boundary === -1 ? forwardedArguments : [])],
      );
      const wrapperFailure =
        failure ?? testWrapperCollectionFailure(packageDirectory, candidate);
      if (wrapperFailure === undefined) {
        return undefined;
      }
      firstFailure ??= wrapperFailure;
      continue;
    }
    if (words[index + 1] !== "test") {
      continue;
    }
    const { words: remaining, end } = shellCommandSpan(tokens, index + 2);
    const arguments_ = [
      ...remaining,
      ...(end === -1 ? forwardedArguments : []),
    ];
    const relativeCandidate = repoRelativePath(packageDirectory, candidate);
    const failure = bunArgumentCollectionFailure(relativeCandidate, arguments_);
    if (failure === undefined) {
      return undefined;
    }
    firstFailure ??= failure;
  }
  if (firstFailure !== undefined) {
    return firstFailure;
  }
  return [
    "runner command: test script does not invoke a gating test runner",
    conditions.at(0),
  ]
    .filter((reason) => reason !== undefined)
    .join("; ");
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

type MatrixLeg = Record<string, unknown>;

const matrixEntryMatches = (leg: MatrixLeg, entry: MatrixLeg): boolean =>
  Object.entries(entry).every(([key, value]) => leg[key] === value);

const cartesianMatrix = (axes: readonly [string, readonly unknown[]][]) => {
  let legs: MatrixLeg[] = [{}];
  for (const [name, values] of axes) {
    const expanded: MatrixLeg[] = [];
    for (const leg of legs) {
      for (const value of values) {
        expanded.push({ ...leg, [name]: value });
      }
    }
    legs = expanded;
  }
  return legs;
};

const matrixEntries = (value: unknown, label: string): MatrixLeg[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isRecord)) {
    panic(`${label} must be an array of objects`);
  }
  return value;
};

const conditionExpression = (condition: string): string =>
  condition
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\}\}$/u, "")
    .trim();

type QuotedLiteral = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

// Single-quoted expression literals in order; `''` escapes a quote.
const quotedLiterals = (expression: string): QuotedLiteral[] | undefined => {
  const literals: QuotedLiteral[] = [];
  let index = 0;
  while (index < expression.length) {
    if (expression[index] !== "'") {
      index += 1;
      continue;
    }
    const start = index;
    let text = "";
    index += 1;
    for (;;) {
      if (index >= expression.length) {
        return undefined;
      }
      if (expression[index] === "'") {
        if (expression[index + 1] !== "'") {
          break;
        }
        text += "'";
        index += 2;
        continue;
      }
      text += expression[index];
      index += 1;
    }
    index += 1;
    literals.push({ start, end: index, text });
  }
  return literals;
};

// Matches `fromJSON(<condition> && '<json>' || '<json>')` and returns both literals.
const literalIncludeChoice = (
  include: string,
): readonly [string, string] | undefined => {
  const expression = conditionExpression(include);
  if (!expression.startsWith("fromJSON(") || !expression.endsWith(")")) {
    return undefined;
  }
  const inner = expression.slice("fromJSON(".length, -1);
  const literals = quotedLiterals(inner);
  const whenTrue = literals?.at(-2);
  const whenFalse = literals?.at(-1);
  if (whenTrue === undefined || whenFalse === undefined) {
    return undefined;
  }
  const condition = inner.slice(0, whenTrue.start).trimEnd();
  if (
    !condition.endsWith("&&") ||
    condition.slice(0, -2).trim().length === 0 ||
    inner.slice(whenTrue.end, whenFalse.start).trim() !== "||" ||
    inner.slice(whenFalse.end).trim() !== ""
  ) {
    return undefined;
  }
  return [whenTrue.text, whenFalse.text];
};

const literalMatrixEntries = (literal: string): MatrixLeg[] | undefined => {
  try {
    const value: unknown = JSON.parse(literal);
    return Array.isArray(value) && value.every(isRecord) ? value : undefined;
  } catch {
    return undefined;
  }
};

// `fromJSON(cond && '<json>' || '<json>')` selects one of two literal include
// lists at runtime. Only entries present in both lists run whatever the
// condition evaluates to, so only those legs can credit a gating command.
const conditionalLiteralInclude = (
  include: string,
): MatrixLeg[] | undefined => {
  const choice = literalIncludeChoice(include);
  const whenTrue = literalMatrixEntries(choice?.[0] ?? "");
  const whenFalse = literalMatrixEntries(choice?.[1] ?? "");
  if (whenTrue === undefined || whenFalse === undefined) {
    return undefined;
  }
  const common = whenTrue.filter((entry) =>
    whenFalse.some(
      (candidate) =>
        Object.keys(candidate).length === Object.keys(entry).length &&
        matrixEntryMatches(candidate, entry),
    ),
  );
  return common.length > 0 ? common : undefined;
};

const matrixLegs = (job: Record<string, unknown>): readonly MatrixLeg[] => {
  const strategy = workflowRecord(job["strategy"]);
  const matrix = strategy?.["matrix"];
  if (matrix === undefined) {
    return [{}];
  }
  if (!isRecord(matrix)) {
    // Planner-produced matrices remain existential: their fields are runtime
    // outputs, which the success-path policy deliberately permits.
    return [{}];
  }
  const axes: [string, readonly unknown[]][] = [];
  for (const [name, values] of Object.entries(matrix)) {
    if (name === "include" || name === "exclude") {
      continue;
    }
    if (!Array.isArray(values)) {
      return [{}];
    }
    axes.push([name, values]);
  }
  const conditionalInclude =
    typeof matrix["include"] === "string"
      ? conditionalLiteralInclude(matrix["include"])
      : undefined;
  if (
    (matrix["include"] !== undefined &&
      !Array.isArray(matrix["include"]) &&
      conditionalInclude === undefined) ||
    (matrix["exclude"] !== undefined && !Array.isArray(matrix["exclude"]))
  ) {
    return [{}];
  }
  const originals = cartesianMatrix(axes);
  const excludes = matrixEntries(matrix["exclude"], "matrix.exclude");
  const included =
    conditionalInclude ?? matrixEntries(matrix["include"], "matrix.include");
  let legs = originals.filter(
    (leg) => !excludes.some((entry) => matrixEntryMatches(leg, entry)),
  );
  for (const entry of included) {
    const compatible = legs.filter((leg) =>
      Object.entries(entry).every(
        ([key, value]) => !(key in leg) || leg[key] === value,
      ),
    );
    if (compatible.length === 0) {
      // GitHub applies exclude before include, so include can add back an excluded leg.
      legs.push(entry);
      continue;
    }
    const compatibleSet = new Set(compatible);
    legs = legs.map((leg) =>
      compatibleSet.has(leg) ? { ...leg, ...entry } : leg,
    );
  }
  return legs;
};

const hasDynamicMatrix = (job: Record<string, unknown>): boolean => {
  const matrix = workflowRecord(workflowRecord(job["strategy"])?.["matrix"]);
  if (matrix === undefined) {
    return workflowRecord(job["strategy"])?.["matrix"] !== undefined;
  }
  return Object.entries(matrix).some(
    ([name, value]) =>
      name !== "exclude" && name !== "include" && !Array.isArray(value),
  );
};

type GatingContextOptions = {
  readonly eventName: (typeof GATING_EVENTS)[number];
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly matrix: MatrixLeg;
  readonly variables: Readonly<Record<string, string | boolean>>;
};

const gatingEventContext = (
  { eventName, inputs, matrix, variables }: GatingContextOptions,
  expression = "",
) => {
  const steps = Object.fromEntries(
    [...expression.matchAll(/\bsteps\.([\w-]+)\.(outcome|conclusion)\b/gu)]
      .map((match) => match[1])
      .filter((id): id is string => id !== undefined)
      .map((id) => [id, { conclusion: "success", outcome: "success" }]),
  );
  const needs = Object.fromEntries(
    [...expression.matchAll(/\bneeds\.([\w-]+)\.result\b/gu)]
      .map((match) => match[1])
      .filter((id): id is string => id !== undefined)
      .map((id) => [id, { result: "success" }]),
  );
  return contextFromNested({
    always: () => true,
    cancelled: () => false,
    failure: () => false,
    github: {
      event: {
        pull_request: eventName === "pull_request" ? { draft: false } : null,
      },
      event_name: eventName,
    },
    inputs,
    matrix,
    needs,
    steps,
    success: () => true,
    vars: variables,
  });
};

const referencedContexts = (expression: string): readonly string[] =>
  [...expression.matchAll(/\b[A-Za-z_][\w-]*(?:\.[\w-]+)+/gu)]
    .map((match) => match[0])
    .toSorted(compareCodeUnit);

type ExecutableConditionOptions = GatingContextOptions & {
  readonly condition: unknown;
  readonly declaredInputs: ReadonlySet<string>;
  readonly dynamicMatrix: boolean;
};

const executableCondition = ({
  condition,
  declaredInputs,
  dynamicMatrix,
  ...contextOptions
}: ExecutableConditionOptions): {
  readonly executable: boolean;
  readonly staticallyFalse: boolean;
  readonly unresolved: readonly string[];
} => {
  if (condition === undefined || condition === true) {
    return { executable: true, staticallyFalse: false, unresolved: [] };
  }
  if (condition === false || typeof condition !== "string") {
    return { executable: false, staticallyFalse: true, unresolved: [] };
  }
  const expression = conditionExpression(condition);
  const unresolved = referencedContexts(expression).filter((reference) => {
    if (
      /^steps\.[\w-]+\.(?:conclusion|outcome|outputs\.[\w-]+)$/u.test(
        reference,
      ) ||
      /^needs\.[\w-]+\.(?:result|outputs\.[\w-]+)$/u.test(reference)
    ) {
      return false;
    }
    if (reference.startsWith("github.")) {
      return false;
    }
    const [root, name] = reference.split(".");
    if (root === "vars") {
      if (name === undefined || name in contextOptions.variables) {
        return false;
      }
      // Literals the expression compares against are the values that can
      // change its outcome; registered defaults are handled above.
      const samples = new Set([
        "",
        "off",
        "on",
        ...(quotedLiterals(expression) ?? []).map(({ text }) => text),
      ]);
      const results = [...samples].map((value) =>
        evaluate(
          expression,
          gatingEventContext(
            {
              ...contextOptions,
              variables: { ...contextOptions.variables, [name]: value },
            },
            expression,
          ),
        ),
      );
      return results.some((result) => result !== results.at(0));
    }
    if (root === "inputs") {
      if (name === undefined || declaredInputs.has(name)) {
        return false;
      }
      const results = [false, true, ""].map((value) =>
        evaluate(
          expression,
          gatingEventContext(
            {
              ...contextOptions,
              inputs: { ...contextOptions.inputs, [name]: value },
            },
            expression,
          ),
        ),
      );
      return results.some((result) => result !== results.at(0));
    }
    if (root === "matrix") {
      return (
        !dynamicMatrix && !(name !== undefined && name in contextOptions.matrix)
      );
    }
    return true;
  });
  const context = gatingEventContext(contextOptions, expression);
  const evaluated = evaluate(expression, context);
  const staticallyFalse = definitelyFalse(expression, context);
  return {
    executable:
      evaluated === true || (unresolved.length === 0 && !staticallyFalse),
    staticallyFalse,
    unresolved,
  };
};

const ignoresFailure = (
  continueOnError: unknown,
  contextOptions: GatingContextOptions,
): boolean => {
  if (continueOnError === true) {
    return true;
  }
  if (continueOnError === false || typeof continueOnError !== "string") {
    return false;
  }
  // An expression that cannot be resolved statically may allow failures at
  // runtime, so only a statically false value keeps the step gating.
  return (
    evaluate(
      conditionExpression(continueOnError),
      gatingEventContext(contextOptions, conditionExpression(continueOnError)),
    ) !== false
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

type WorkflowShell =
  | { readonly type: "supported"; readonly propagation: ShellPropagation }
  | { readonly type: "unsupported"; readonly name: string };

const BASH_PROPAGATION: ShellPropagation = { errexit: true, pipefail: true };

const shellPropagation = (shell: string): WorkflowShell => {
  const [executable, ...arguments_] = shell.trim().split(/\s+/u);
  if (executable !== "bash") {
    return { type: "unsupported", name: shell };
  }
  if (arguments_.length === 0) {
    return { type: "supported", propagation: BASH_PROPAGATION };
  }
  if (
    arguments_.at(-1) !== "{0}" ||
    arguments_.filter((arg) => arg === "{0}").length !== 1
  ) {
    return { type: "unsupported", name: shell };
  }
  let errexit = false;
  let pipefail = false;
  for (let index = 0; index < arguments_.length - 1; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      return { type: "unsupported", name: shell };
    }
    if (argument === "--noprofile" || argument === "--norc") {
      continue;
    }
    if (/^[-+][eu]+$/u.test(argument)) {
      if (argument.includes("e")) {
        errexit = argument.startsWith("-");
      }
      continue;
    }
    if (/^[-+][eu]*o$/u.test(argument)) {
      if (argument.includes("e")) {
        errexit = argument.startsWith("-");
      }
      const option = arguments_[index + 1];
      if (!new Set(["errexit", "nounset", "pipefail"]).has(option ?? "")) {
        return { type: "unsupported", name: shell };
      }
      if (option === "errexit") {
        errexit = argument.startsWith("-");
      }
      if (option === "pipefail") {
        pipefail = argument.startsWith("-");
      }
      index += 1;
      continue;
    }
    return { type: "unsupported", name: shell };
  }
  return {
    type: "supported",
    propagation: { errexit, pipefail },
  };
};

type EffectiveWorkflowShellOptions = {
  readonly root: Record<string, unknown> | undefined;
  readonly job: Record<string, unknown>;
  readonly step: Record<string, unknown>;
  readonly legs: readonly MatrixLeg[];
};

const effectiveWorkflowShell = ({
  root,
  job,
  step,
  legs,
}: EffectiveWorkflowShellOptions): WorkflowShell => {
  const stepShell = step["shell"];
  const jobDefaults = workflowRecord(job["defaults"]);
  const jobRunDefaults = workflowRecord(jobDefaults?.["run"]);
  const rootDefaults = workflowRecord(root?.["defaults"]);
  const rootRunDefaults = workflowRecord(rootDefaults?.["run"]);
  const shell =
    stepShell ?? jobRunDefaults?.["shell"] ?? rootRunDefaults?.["shell"];
  if (typeof shell === "string") {
    return shellPropagation(shell);
  }
  const runsOn = job["runs-on"];
  const matrixRunners = legs.flatMap((leg) => {
    const runner = leg["runner"] ?? leg["os"];
    return typeof runner === "string" ? [runner] : [];
  });
  let platforms: readonly unknown[] = matrixRunners;
  if (platforms.length === 0) {
    platforms = Array.isArray(runsOn) ? runsOn : [runsOn];
  }
  if (runsOn === undefined && matrixRunners.length === 0) {
    return { type: "supported", propagation: BASH_PROPAGATION };
  }
  if (
    platforms.every(
      (value) =>
        typeof value === "string" &&
        /^(?:ubuntu|linux|macos)(?:-|$)/u.test(value),
    )
  ) {
    return { type: "supported", propagation: BASH_PROPAGATION };
  }
  return {
    type: "unsupported",
    name: typeof runsOn === "string" ? `default on ${runsOn}` : "default shell",
  };
};

export type GatingWorkflowAnalysis = {
  readonly findings: readonly string[];
  readonly jobs: ReadonlyMap<string, readonly GatingCommand[]>;
};

export const analyzeGatingWorkflow = (
  workflow: unknown,
): GatingWorkflowAnalysis => {
  const root = workflowRecord(workflow);
  const jobs = workflowRecord(root?.["jobs"]);
  const resultJob = workflowRecord(jobs?.["ci-result"]);
  if (jobs === undefined || resultJob === undefined) {
    return { findings: [], jobs: new Map() };
  }
  const needs = resultJob["needs"];
  let names: string[] = [];
  if (Array.isArray(needs)) {
    names = needs.filter((name): name is string => typeof name === "string");
  } else if (typeof needs === "string") {
    names = [needs];
  }
  if (names.length === 0) {
    return { findings: [], jobs: new Map() };
  }
  const workflowCall = workflowRecord(
    workflowRecord(root?.["on"])?.["workflow_call"],
  );
  const inputDeclarations = workflowRecord(workflowCall?.["inputs"]);
  const defaultedInputs = Object.entries(inputDeclarations ?? {}).flatMap(
    ([name, declarationValue]) => {
      const declaration = workflowRecord(declarationValue);
      return declaration !== undefined && "default" in declaration
        ? [[name, declaration["default"]]]
        : [];
    },
  );
  const inputs = Object.fromEntries(defaultedInputs);
  const declaredInputs = new Set(Object.keys(inputs));
  const variables = Object.fromEntries(
    readDefaultOnContexts().map((entry) => [
      entry.context.slice("vars.".length),
      entry.value,
    ]),
  );
  const findings = new Set<string>();
  const gating = new Map<string, readonly GatingCommand[]>();
  for (const name of names) {
    const job = workflowRecord(jobs[name]);
    if (job === undefined) {
      continue;
    }
    if (!Array.isArray(job["steps"])) {
      continue;
    }
    const dynamicMatrix = hasDynamicMatrix(job);
    const legs = matrixLegs(job);
    const commands = flattenWorkflowSteps(job["steps"]).flatMap(
      (step, stepIndex) => {
        if (typeof step["run"] !== "string") {
          return [];
        }
        let blocksMerge = false;
        const unresolvedContexts = new Set<string>();
        for (const eventName of GATING_EVENTS) {
          for (const matrix of legs) {
            const contextOptions = { eventName, inputs, matrix, variables };
            const jobCondition = executableCondition({
              ...contextOptions,
              condition: job["if"],
              declaredInputs,
              dynamicMatrix,
            });
            const stepCondition = executableCondition({
              ...contextOptions,
              condition: step["if"],
              declaredInputs,
              dynamicMatrix,
            });
            if (
              !jobCondition.staticallyFalse &&
              !stepCondition.staticallyFalse
            ) {
              for (const context of [
                ...jobCondition.unresolved,
                ...stepCondition.unresolved,
              ]) {
                unresolvedContexts.add(context);
              }
            }
            if (
              jobCondition.executable &&
              stepCondition.executable &&
              !ignoresFailure(job["continue-on-error"], contextOptions) &&
              !ignoresFailure(step["continue-on-error"], contextOptions)
            ) {
              blocksMerge = true;
            }
          }
        }
        if (!blocksMerge) {
          for (const context of unresolvedContexts) {
            findings.add(
              `job condition: ${name}/step-${stepIndex + 1} has unresolved context ${context}`,
            );
          }
        }
        if (!blocksMerge) {
          return [];
        }
        const shell = effectiveWorkflowShell({ root, job, step, legs });
        if (shell.type === "unsupported") {
          if (
            shellTokens(step["run"]).some(
              (token) =>
                token.role === "command" &&
                ["bun", "playwright"].includes(token.value),
            )
          ) {
            findings.add(
              `job condition: ${name}/step-${stepIndex + 1} uses unsupported shell ${shell.name}`,
            );
          }
          return [];
        }
        return [
          {
            command: executableShell(step["run"]),
            environment: {
              ...workflowRecord(root?.["env"]),
              ...workflowRecord(job["env"]),
              ...workflowRecord(step["env"]),
            },
            propagation: shell.propagation,
          },
        ];
      },
    );
    if (commands.length > 0) {
      gating.set(name, commands);
    }
  }
  return {
    findings: [...findings].toSorted(compareCodeUnit),
    jobs: gating,
  };
};

export const gatingWorkflowJobs = (
  workflow: unknown,
): ReadonlyMap<string, readonly GatingCommand[]> =>
  analyzeGatingWorkflow(workflow).jobs;

type RepositoryTestExecutionTopology = {
  readonly workflow: string;
  readonly gatingJobs: ReadonlyMap<string, readonly GatingCommand[]>;
  readonly shardedPackages: ReadonlySet<string>;
};

let cachedRepositoryTestExecutionTopology:
  | RepositoryTestExecutionTopology
  | undefined;

const repositoryTestExecutionTopology = (): RepositoryTestExecutionTopology => {
  if (cachedRepositoryTestExecutionTopology !== undefined) {
    return cachedRepositoryTestExecutionTopology;
  }
  const workflow = readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf-8",
  );
  const packageNames = workspacePackages()
    .filter(({ hasTestScript }) => hasTestScript)
    .map(({ name }) => name);
  const analysis = analyzeGatingWorkflow(Bun.YAML.parse(workflow));
  const gatingJobs = analysis.jobs;
  const planJob =
    gatingJobs
      .get("ci-plan")
      ?.map(({ command }) => command)
      .join("\n") ?? "";
  cachedRepositoryTestExecutionTopology = {
    workflow,
    gatingJobs,
    shardedPackages: new Set(
      Object.entries(TEST_JOB_SHARDS).flatMap(([jobShard, shards]) =>
        planJob.includes(`"${jobShard}"`)
          ? shards.flatMap((shard) => shardPackages({ packageNames, shard }))
          : [],
      ),
    ),
  };
  return cachedRepositoryTestExecutionTopology;
};

type PlaywrightCollection =
  | { readonly type: "collected" }
  | { readonly type: "not-collected" }
  | { readonly type: "unresolved"; readonly finding: string };

type PlaywrightConfigSource = {
  readonly configFile: string;
  readonly source: string;
  readonly readConfig: (configFile: string) => string;
  readonly visited?: ReadonlySet<string>;
};

type PlaywrightConfigOptions = PlaywrightConfigSource & {
  readonly file: string;
  readonly projects: readonly string[];
};

const playwrightObjectFields = (
  expression: ts.Expression,
): Map<string, ts.Expression> | undefined => {
  if (!ts.isObjectLiteralExpression(expression)) {
    return undefined;
  }
  const fields = new Map<string, ts.Expression>();
  for (const property of expression.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    ) {
      return undefined;
    }
    fields.set(property.name.text, property.initializer);
  }
  return fields;
};

const playwrightConfigFields = ({
  configFile,
  source,
  readConfig,
  visited: visitedConfigs = new Set(),
}: PlaywrightConfigSource): Map<string, ts.Expression> | undefined => {
  if (visitedConfigs.has(configFile)) {
    return undefined;
  }
  const ast = parseTypeScript(configFile, source);
  const readConstants = () => {
    const entries = new Map<string, ts.Expression>();
    for (const statement of ast.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        statement.declarationList.getFirstToken(ast)?.kind !==
          ts.SyntaxKind.ConstKeyword
      ) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined
        ) {
          entries.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    return entries;
  };
  const constants = readConstants();
  const resolve = (expression: ts.Expression): ts.Expression => {
    let node = expression;
    const visited = new Set<string>();
    while (true) {
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node)
      ) {
        node = node.expression;
        continue;
      }
      if (!ts.isIdentifier(node) || visited.has(node.text)) {
        return node;
      }
      visited.add(node.text);
      const initializer = constants.get(node.text);
      if (initializer === undefined) {
        return node;
      }
      node = initializer;
    }
  };
  const expand = (
    expression: ts.Expression,
    visited = new Set<ts.Expression>(),
  ): ts.Expression => {
    const node = resolve(expression);
    if (visited.has(node)) {
      return node;
    }
    const next = new Set([...visited, node]);
    if (ts.isArrayLiteralExpression(node)) {
      return ts.factory.createArrayLiteralExpression(
        node.elements.map((element) => expand(element, next)),
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      return ts.factory.createObjectLiteralExpression(
        node.properties.map((property) =>
          ts.isPropertyAssignment(property)
            ? ts.factory.createPropertyAssignment(
                property.name,
                expand(property.initializer, next),
              )
            : property,
        ),
      );
    }
    return node;
  };
  const exported = ast.statements.find(ts.isExportAssignment);
  if (exported === undefined) {
    return undefined;
  }
  const exportedExpression = resolve(exported.expression);
  const layers = ts.isCallExpression(exportedExpression)
    ? exportedExpression.arguments
    : [exportedExpression];
  const root = new Map<string, ts.Expression>();
  for (const layer of layers) {
    let fields = playwrightObjectFields(expand(layer));
    const node = resolve(layer);
    if (fields === undefined && ts.isIdentifier(node)) {
      const imported = ast.statements.find(
        (statement) =>
          ts.isImportDeclaration(statement) &&
          statement.importClause?.name?.text === node.text,
      );
      if (
        imported !== undefined &&
        ts.isImportDeclaration(imported) &&
        ts.isStringLiteral(imported.moduleSpecifier) &&
        imported.moduleSpecifier.text.startsWith(".")
      ) {
        const modulePath = path.posix.join(
          path.posix.dirname(configFile),
          imported.moduleSpecifier.text,
        );
        const importedFile = [modulePath, `${modulePath}.ts`].find((file) =>
          existsSync(path.join(ROOT, file)),
        );
        if (importedFile !== undefined) {
          fields = playwrightConfigFields({
            configFile: importedFile,
            source: readConfig(path.join(ROOT, importedFile)),
            readConfig,
            visited: new Set([...visitedConfigs, configFile]),
          });
        }
      }
    }
    if (fields === undefined) {
      return undefined;
    }
    for (const [name, value] of fields) {
      root.set(name, value);
    }
  }
  return root;
};

const playwrightConfigCollection = (
  options: PlaywrightConfigOptions,
): PlaywrightCollection => {
  const { file, configFile, projects: selectedProjects } = options;
  const root = playwrightConfigFields(options);
  const unresolved = (field: string): PlaywrightCollection => ({
    type: "unresolved",
    finding: `runner config: ${configFile} has unresolved ${field}`,
  });
  if (root === undefined) {
    return unresolved("configuration object");
  }
  const projects = root.get("projects");
  const scopes: Map<string, ts.Expression>[] = [];
  if (projects === undefined) {
    scopes.push(root);
  } else {
    const node = projects;
    if (!ts.isArrayLiteralExpression(node)) {
      return unresolved("projects");
    }
    for (const project of node.elements) {
      const fields = playwrightObjectFields(project);
      if (fields === undefined) {
        return unresolved("project configuration");
      }
      scopes.push(new Map([...root, ...fields]));
    }
  }
  type Patterns =
    | {
        readonly type: "patterns";
        readonly values: readonly (string | RegExp)[];
      }
    | { readonly type: "unresolved" };
  const patterns = (expression: ts.Expression): Patterns => {
    const node = expression;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { type: "patterns", values: [node.text] };
    }
    if (ts.isRegularExpressionLiteral(node)) {
      const delimiter = node.text.lastIndexOf("/");
      // Literal regexes are static configuration; constructors and other
      // executable expressions remain unresolved.
      const compiled = Result.try(
        () =>
          new RegExp(
            node.text.slice(1, delimiter),
            node.text.slice(delimiter + 1),
          ),
      );
      return compiled.isErr()
        ? { type: "unresolved" }
        : { type: "patterns", values: [compiled.value] };
    }
    if (!ts.isArrayLiteralExpression(node)) {
      return { type: "unresolved" };
    }
    const values: (string | RegExp)[] = [];
    for (const element of node.elements) {
      const parsed = patterns(element);
      if (
        parsed.type === "unresolved" ||
        ts.isArrayLiteralExpression(element)
      ) {
        return { type: "unresolved" };
      }
      values.push(...parsed.values);
    }
    return { type: "patterns", values };
  };
  let collected = false;
  for (const scope of scopes) {
    if (selectedProjects.length > 0) {
      const name = scope.get("name");
      if (name !== undefined && !ts.isStringLiteral(name)) {
        return unresolved("project name");
      }
      if (
        !selectedProjects.some((project) =>
          new RegExp(
            `^${project.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`,
            "u",
          ).test(name?.text ?? ""),
        )
      ) {
        continue;
      }
    }
    // Title filters select tests inside files; file-level collection cannot
    // prove that a matched file still runs any of them.
    for (const filter of ["grep", "grepInvert"]) {
      if (scope.get(filter) !== undefined) {
        return unresolved(filter);
      }
    }
    const testDir = scope.get("testDir");
    const directory = testDir;
    if (
      directory === undefined ||
      !(
        ts.isStringLiteral(directory) ||
        ts.isNoSubstitutionTemplateLiteral(directory)
      )
    ) {
      return unresolved("testDir");
    }
    const relative = repoRelativePath(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(configFile), directory.text),
      ),
      file,
    );
    const matches = (value: string | RegExp): boolean => {
      if (typeof value === "string") {
        return playwrightGlobMatches(value, relative);
      }
      value.lastIndex = 0;
      return value.test(file);
    };
    const testMatch = scope.get("testMatch");
    const match = testMatch === undefined ? undefined : patterns(testMatch);
    const testIgnore = scope.get("testIgnore");
    const ignore = testIgnore === undefined ? undefined : patterns(testIgnore);
    if (match?.type === "unresolved") {
      return unresolved("testMatch");
    }
    if (ignore?.type === "unresolved") {
      return unresolved("testIgnore");
    }
    if (
      !relative.startsWith("../") &&
      (match === undefined || match.values.some(matches)) &&
      (ignore === undefined || !ignore.values.some(matches))
    ) {
      collected = true;
    }
  }
  return collected ? { type: "collected" } : { type: "not-collected" };
};

type PlaywrightCLI =
  | {
      readonly type: "resolved";
      readonly configName: string;
      readonly projects: readonly string[];
      readonly files: readonly RegExp[];
    }
  | {
      readonly type: "unresolved";
      readonly finding: string;
      readonly configName: string;
    };

const resolvedCLIValue = (value: string | undefined): value is string =>
  value !== undefined && !value.startsWith("-") && !value.includes("$");

const playwrightCLI = (
  arguments_: readonly string[],
  command: string,
): PlaywrightCLI => {
  let configName = "playwright.config.ts";
  const projects: string[] = [];
  const files: RegExp[] = [];
  let positionalOnly = false;
  const unresolved = (argument: string): PlaywrightCLI => ({
    type: "unresolved",
    configName,
    finding: `runner command: ${command} has unresolved Playwright selection ${argument}`,
  });
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals === -1 ? argument : argument.slice(0, equals);
    if (
      !positionalOnly &&
      ["--config", "-c", "--project", "--shard"].includes(option)
    ) {
      const value =
        equals === -1 ? arguments_[index + 1] : argument.slice(equals + 1);
      if (!resolvedCLIValue(value)) {
        return unresolved(argument);
      }
      if (equals === -1) {
        index += 1;
      }
      if (option === "--project") {
        projects.push(value);
        while (
          arguments_.at(index + 1) !== undefined &&
          !arguments_.at(index + 1)?.startsWith("-")
        ) {
          const project = arguments_.at(index + 1);
          if (project === undefined || project.includes("$")) {
            return unresolved(argument);
          }
          projects.push(project);
          index += 1;
        }
      } else if (option === "--shard") {
        return unresolved(argument);
      } else {
        configName = value;
      }
      continue;
    }
    if (
      [
        "--headed",
        "--forbid-only",
        "--fully-parallel",
        "--quiet",
        "--ignore-snapshots",
      ].includes(option) &&
      !positionalOnly
    ) {
      continue;
    }
    if (
      [
        "--workers",
        "-j",
        "--retries",
        "--timeout",
        "--reporter",
        "--output",
        "--trace",
        "--update-snapshots",
      ].includes(option) &&
      !positionalOnly
    ) {
      const value =
        equals === -1 ? arguments_[index + 1] : argument.slice(equals + 1);
      if (!resolvedCLIValue(value)) {
        return unresolved(argument);
      }
      if (equals === -1) {
        index += 1;
      }
      continue;
    }
    if (
      (!positionalOnly && argument.startsWith("-")) ||
      /\$(?:[A-Za-z_]|\{|\()/u.test(argument) ||
      /:\d+(?::\d+)?$/u.test(argument)
    ) {
      return unresolved(argument);
    }
    const pattern = Result.try(() => new RegExp(argument, "u"));
    if (pattern.isErr()) {
      return unresolved(argument);
    }
    files.push(pattern.value);
  }
  return { type: "resolved", configName, projects, files };
};

type GatingPlaywrightOptions = {
  readonly readConfig?: (configFile: string) => string;
  readonly file: string;
  readonly packageFile: string;
  readonly scripts: PackageScripts;
  readonly topology: RepositoryTestExecutionTopology;
};

export const gatingPlaywrightCollection = ({
  readConfig = (configFile) => readFileSync(configFile, "utf-8"),
  file,
  packageFile,
  scripts,
  topology,
}: GatingPlaywrightOptions): PlaywrightCollection => {
  const parsed = readJson(packageFile);
  if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) {
    return { type: "not-collected" };
  }
  const packageName = parsed.name;
  if (typeof packageName !== "string") {
    return { type: "not-collected" };
  }
  const packageDirectory = path.posix.dirname(packageFile);
  let finding: PlaywrightCollection = { type: "not-collected" };
  for (const [scriptName, command] of Object.entries(scripts)) {
    if (
      typeof command !== "string" ||
      !shellInvocationGates({
        command,
        matches: ({ words, index }) =>
          words[index] === "playwright" && words[index + 1] === "test",
        propagation: PACKAGE_SCRIPT_PROPAGATION,
      }) ||
      packageTestExecutionFailure({
        ...topology,
        packageDirectory,
        packageName,
        scriptName,
      }) !== undefined
    ) {
      continue;
    }
    const bodies = gatingArguments({
      command,
      invocationEnd: ({ words, index }) =>
        words[index] === "playwright" && words[index + 1] === "test"
          ? index + 2
          : undefined,
    });
    for (const commands of topology.gatingJobs.values()) {
      const invocations = commands.flatMap(
        ({ command: workflowCommand, propagation }) =>
          gatingArguments({
            command: workflowCommand,
            propagation,
            invocationEnd: ({ words, tokens, index }) =>
              packageInvocationEnd({
                words,
                tokens,
                index,
                packageDirectory,
                packageName,
                scriptName,
                propagation,
              }),
          }).map((arguments_) => ({
            workflowCommand,
            arguments_:
              arguments_.at(0) === "--" ? arguments_.slice(1) : arguments_,
          })),
      );
      for (const body of bodies) {
        const selections = invocations.map(({ workflowCommand, arguments_ }) =>
          playwrightCLI(
            [...body, ...arguments_],
            `${command} (workflow: ${workflowCommand})`,
          ),
        );
        for (const cli of selections) {
          if (cli.type === "unresolved") {
            const configFile = path.join(
              ROOT,
              packageDirectory,
              cli.configName,
            );
            if (
              existsSync(configFile) &&
              playwrightConfigCollection({
                file,
                configFile: path.posix.join(packageDirectory, cli.configName),
                source: readConfig(configFile),
                readConfig,
                projects: [],
              }).type === "not-collected"
            ) {
              continue;
            }
            finding = { type: "unresolved", finding: cli.finding };
            continue;
          }
          if (
            cli.files.length > 0 &&
            !cli.files.some((pattern) => pattern.test(path.join(ROOT, file)))
          ) {
            continue;
          }
          const configFile = path.join(ROOT, packageDirectory, cli.configName);
          if (!existsSync(configFile)) {
            finding = {
              type: "unresolved",
              finding: `runner config: ${configFile} is missing`,
            };
            continue;
          }
          const collection = playwrightConfigCollection({
            file,
            configFile: path.posix.join(packageDirectory, cli.configName),
            source: readConfig(configFile),
            readConfig,
            projects: cli.projects,
          });
          if (collection.type === "collected") {
            return collection;
          }
          if (collection.type === "unresolved") {
            finding = collection;
          }
        }
      }
    }
  }
  return finding;
};

type FirstCollectionOptions = {
  readonly file: string;
  readonly nonGatingFiles: ReadonlySet<string>;
  readonly topology?: RepositoryTestExecutionTopology;
};

type NestedShell =
  | { readonly type: "none" }
  | { readonly type: "unsupported"; readonly reason: string }
  | {
      readonly type: "supported";
      readonly body: string;
      readonly propagation: ShellPropagation;
    };

const nestedShellInvocation = ({
  words,
  tokens,
  index,
}: ShellInvocation): NestedShell => {
  let start = index;
  if (words[start] === "env") {
    start += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[start] ?? "")) {
      const assignment = words[start] ?? "";
      if (
        !literalShellWord(assignment) ||
        /^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS)=/u.test(assignment)
      ) {
        return {
          type: "unsupported",
          reason: "shell condition: unresolved nested shell environment",
        };
      }
      start += 1;
    }
  }
  if (!["bash", "sh"].includes(words[start] ?? "")) {
    const children = tokens
      .slice(index + 1)
      .filter((token) => ["bash", "sh"].includes(token.value));
    if (children.some((token) => token.role === "argument")) {
      return {
        type: "unsupported",
        reason: "shell condition: unsupported nested shell wrapper",
      };
    }
    return { type: "none" };
  }
  const flags: string[] = [];
  for (let cursor = start + 1; cursor < words.length; cursor += 1) {
    if (tokens[cursor]?.role !== "argument") {
      break;
    }
    const argument = words[cursor];
    if (argument === undefined) {
      break;
    }
    if (!/^-[eu]*c$/u.test(argument)) {
      flags.push(argument);
      continue;
    }
    const short = argument.slice(1, -1);
    if (short.length > 0) {
      flags.push(`-${short}`);
    }
    const body = words[cursor + 1];
    if (
      tokens[cursor + 1]?.role !== "argument" ||
      body === undefined ||
      !literalShellWord(body) ||
      tokens[cursor + 2]?.role === "argument"
    ) {
      return {
        type: "unsupported",
        reason:
          "shell condition: nested shell body and arguments must be literal",
      };
    }
    const shell = shellPropagation(`bash ${flags.join(" ")} {0}`);
    if (shell.type === "unsupported") {
      return {
        type: "unsupported",
        reason: "shell condition: unsupported nested shell options",
      };
    }
    return { type: "supported", body, propagation: shell.propagation };
  }
  return {
    type: "unsupported",
    reason: "shell condition: nested shell requires a literal -c body",
  };
};

export const firstCollectionFailure = ({
  file,
  nonGatingFiles,
  topology = repositoryTestExecutionTopology(),
}: FirstCollectionOptions): string | undefined => {
  if (nonGatingFiles.has(file)) {
    return undefined;
  }
  if (file.startsWith("scripts/") || file.startsWith(".oxlint-plugins/")) {
    const isUnlistedScript =
      new Bun.Glob("scripts/**/*.test.ts").match(file) &&
      unlistedTests([file], topology.workflow).length === 1;
    const conditions: string[] = [];
    const commandMatches = (gatingCommand: GatingCommand): boolean => {
      const { command, propagation } = gatingCommand;
      return shellInvocationGates({
        command,
        propagation,
        onUnresolved: (reason) => {
          conditions.push(reason);
        },
        matches: ({ words, tokens, index }) => {
          const nested = nestedShellInvocation({ words, tokens, index });
          if (nested.type === "unsupported") {
            conditions.push(nested.reason);
            return false;
          }
          if (nested.type === "supported") {
            return commandMatches({
              command: nested.body,
              propagation: nested.propagation,
              environment: gatingCommand.environment,
            });
          }
          if (
            isUnlistedScript &&
            words[index] === "bun" &&
            words[index + 1] === "scripts/run-unlisted-script-tests.ts"
          ) {
            return true;
          }
          if (words[index] !== "bun") {
            return false;
          }
          const { words: invocation } = shellCommandSpan(tokens, index);
          if (words[index + 1] === "scripts/run-custom-lint-tests.ts") {
            const args = invocation.slice(2);
            if (
              args.some(
                (argument) =>
                  argument === "--timeout" || argument.startsWith("--timeout="),
              )
            ) {
              return false;
            }
            const runner = customLintTestCommand(args);
            return (
              packageTestCollectionFailure({
                candidate: file,
                packageDirectory: ".",
                scripts: {
                  test: ["bun", ...runner.slice(1)]
                    .map((word) => JSON.stringify(word))
                    .join(" "),
                },
              }) === undefined
            );
          }
          const line = invocation.map((word) => JSON.stringify(word)).join(" ");
          if (
            packageTestCollectionFailure({
              candidate: file,
              packageDirectory: ".",
              scripts: { test: line },
            }) === undefined
          ) {
            return true;
          }
          const cwdIndex = invocation.indexOf("--cwd");
          if (
            cwdIndex === -1 ||
            (invocation[cwdIndex - 1] !== "bun" &&
              !(
                invocation[cwdIndex - 1] === "run" &&
                invocation[cwdIndex - 2] === "bun"
              )) ||
            invocation[cwdIndex + 2] !== "test"
          ) {
            return false;
          }
          const packageDirectory = invocation[cwdIndex + 1];
          if (packageDirectory === undefined) {
            return false;
          }
          const manifest = path.posix.join(packageDirectory, "package.json");
          if (!existsSync(path.join(ROOT, manifest))) {
            return false;
          }
          const scripts = packageScripts(manifest);
          const testCommand = scripts?.["test"];
          if (typeof testCommand !== "string") {
            return false;
          }
          const arguments_ = invocation
            .slice(cwdIndex + 3)
            .map((word) => JSON.stringify(word))
            .join(" ");
          return (
            packageTestCollectionFailure({
              candidate: file,
              packageDirectory,
              scripts: { ...scripts, test: `${testCommand} ${arguments_}` },
            }) === undefined
          );
        },
      });
    };
    const failure = gatingCommandExecutionFailure({
      commandMatches,
      gatingJobs: topology.gatingJobs,
      missingMessage: `job condition: no gating job collects ${file}`,
    });
    const condition = conditions.at(0);
    return failure !== undefined && condition !== undefined
      ? `${failure}; ${condition}`
      : failure;
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
  const collectionFailure = packageTestCollectionFailure({
    candidate: file,
    packageDirectory,
    scripts,
  });
  const executionFailure = packageTestExecutionFailure({
    ...topology,
    packageDirectory,
    packageName,
    collection: { candidate: file, scripts },
  });
  if (executionFailure === undefined) {
    return undefined;
  }
  const playwrightCollection = gatingPlaywrightCollection({
    file,
    packageFile,
    scripts,
    topology,
  });
  if (playwrightCollection.type === "collected") {
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
        collection: { candidate: file, scripts },
      }) === undefined
    ) {
      return undefined;
    }
  }
  return playwrightCollection.type === "unresolved"
    ? playwrightCollection.finding
    : (collectionFailure ?? executionFailure);
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
  const analysis = analyzeGatingWorkflow(Bun.YAML.parse(workflow));
  const gatingJobs = analysis.jobs;
  errors.push(...analysis.findings);
  for (const event of ["pull_request:", "merge_group:"]) {
    if (!workflow.includes(event)) {
      errors.push(`job condition: ci.yml does not run for ${event}`);
    }
  }
  const collectors = [
    "ci-checks-rest",
    "ci-tests",
    "desktop-rust-lint",
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
    const runnerFailure = rootCommandExecutionFailure({ command, gatingJobs });
    if (runnerFailure !== undefined) {
      errors.push(runnerFailure);
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
    const brokenEdge = firstCollectionFailure({ file, nonGatingFiles });
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
