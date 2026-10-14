#!/usr/bin/env bun

import { panic, Result } from "better-result";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import { compareCodeUnit } from "../packages/collation/src/collation";
import { sha256Hex } from "../packages/sha256/src/bun";
import { classifiedChecks, staticReuseOutputName } from "./ci-static-checks";
import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };
import {
  E2E_PRODUCTION_PLAN_PIN,
  e2eProductionPlanFingerprint,
} from "./e2e-shard-plan-pin";
import { allE2eShards } from "./e2e-spec-shards-core";
import {
  contextFromNested,
  definitelyFalse,
  evaluate,
} from "./github-expression";
import { customLintTestCommand } from "./run-custom-lint-tests";
import { unlistedTests } from "./run-unlisted-script-tests";
import { literalMemberName } from "./test-gate-members";
import {
  TRUSTED_OUTPUT_PRODUCERS,
  type TrustedOutputProducer,
} from "./test-gate-output-producers";
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

export type PlatformConditionalEntry = {
  readonly identity: string;
  readonly kind: "platform-conditional";
  readonly skippedOn: readonly ["win32"];
};

type DisabledLedger = {
  readonly managedServiceGates: readonly string[];
  readonly identities: readonly string[];
  readonly platformConditionals: readonly PlatformConditionalEntry[];
};

export type ScenarioBlocker = {
  readonly blocker: "unproven-selection-producer" | "stack-status-gate";
  readonly producer: string;
  readonly producerSha256: string;
};

export type TestScenario =
  | {
      readonly type: "non-gating";
      readonly file: string;
      readonly owningWorkflow: string;
      readonly reason: string | ScenarioBlocker;
    }
  | {
      readonly type: "executed";
      readonly file: string;
      readonly reason: string;
      readonly collector: {
        readonly workflow: string;
        readonly job: string;
        readonly command: string;
      };
    }
  | {
      readonly type: "pinned-collector";
      readonly file: string;
      readonly reason: string;
      readonly collector: {
        readonly workflow: string;
        readonly job: string;
        readonly step: string;
        readonly pin: typeof E2E_PRODUCTION_PLAN_PIN;
        readonly condition: string;
      };
    };

type DefaultOnContext = {
  readonly context: string;
  readonly reason: string;
  readonly value: string | boolean;
};

export type RegistrationFinding =
  | {
      readonly identity: string;
      readonly skippedOn?: readonly ["win32"];
      readonly managedServiceGate?: (typeof SERVICE_GATES)[number];
      readonly type: "disabled" | "only";
    }
  | {
      readonly identity: string;
      readonly type: "unresolved";
      readonly reason: string;
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

export const parseDisabledLedger = (value: unknown): DisabledLedger => {
  if (!isRecord(value) || !Array.isArray(value["identities"])) {
    panic(`${DISABLED_LEDGER} must declare an identity inventory`);
  }
  const identities: string[] = [];
  const platformConditionals: PlatformConditionalEntry[] = [];
  for (const entry of value["identities"]) {
    if (typeof entry === "string") {
      identities.push(entry);
      continue;
    }
    if (
      !isRecord(entry) ||
      entry["kind"] !== "platform-conditional" ||
      typeof entry["identity"] !== "string" ||
      !Array.isArray(entry["skippedOn"]) ||
      entry["skippedOn"].length !== 1 ||
      entry["skippedOn"][0] !== "win32"
    ) {
      panic(
        `${DISABLED_LEDGER} contains an invalid platform-conditional entry`,
      );
    }
    identities.push(entry["identity"]);
    platformConditionals.push({
      identity: entry["identity"],
      kind: "platform-conditional",
      skippedOn: ["win32"],
    });
  }
  return {
    managedServiceGates: stringArray(
      value["managedServiceGates"],
      `${DISABLED_LEDGER}.managedServiceGates`,
    ),
    identities,
    platformConditionals,
  };
};

const readDisabledLedger = () => parseDisabledLedger(readJson(DISABLED_LEDGER));

export const parseScenarioLedger = (
  value: unknown,
): readonly TestScenario[] => {
  if (!Array.isArray(value)) {
    panic(`${NON_GATING_LEDGER} must be an array`);
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry["file"] !== "string") {
      panic(`${NON_GATING_LEDGER} contains an invalid entry`);
    }
    const rawReason = entry["reason"];
    if (entry["type"] === "non-gating" && isRecord(rawReason)) {
      if (
        typeof entry["owningWorkflow"] !== "string" ||
        (rawReason["blocker"] !== "unproven-selection-producer" &&
          rawReason["blocker"] !== "stack-status-gate") ||
        typeof rawReason["producer"] !== "string" ||
        typeof rawReason["producerSha256"] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(rawReason["producerSha256"])
      ) {
        panic(`${NON_GATING_LEDGER} contains an invalid structured blocker`);
      }
      return {
        type: "non-gating",
        file: entry["file"],
        owningWorkflow: entry["owningWorkflow"],
        reason: {
          blocker: rawReason["blocker"],
          producer: rawReason["producer"],
          producerSha256: rawReason["producerSha256"],
        },
      } as const satisfies TestScenario;
    }
    if (typeof rawReason !== "string" || rawReason.trim() === "") {
      panic(`${NON_GATING_LEDGER} contains an invalid reason`);
    }
    const common = { file: entry["file"], reason: rawReason };
    if (
      entry["type"] === "non-gating" &&
      typeof entry["owningWorkflow"] === "string"
    ) {
      return {
        type: "non-gating",
        ...common,
        owningWorkflow: entry["owningWorkflow"],
      } as const satisfies TestScenario;
    }
    const collector = entry["collector"];
    if (
      !isRecord(collector) ||
      typeof collector["workflow"] !== "string" ||
      typeof collector["job"] !== "string" ||
      collector["job"].trim() === ""
    ) {
      panic(`${NON_GATING_LEDGER} requires a structured collector`);
    }
    if (
      entry["type"] === "pinned-collector" &&
      collector["pin"] === E2E_PRODUCTION_PLAN_PIN &&
      typeof collector["step"] === "string" &&
      collector["step"].trim() !== "" &&
      typeof collector["condition"] === "string"
    ) {
      return {
        type: "pinned-collector",
        ...common,
        collector: {
          workflow: collector["workflow"],
          job: collector["job"],
          step: collector["step"],
          pin: collector["pin"],
          condition: collector["condition"],
        },
      } as const satisfies TestScenario;
    }
    if (
      entry["type"] !== "executed" ||
      typeof collector["command"] !== "string" ||
      collector["command"].trim() === ""
    ) {
      panic(`${NON_GATING_LEDGER} requires a structured execution collector`);
    }
    return {
      type: "executed",
      ...common,
      collector: {
        workflow: collector["workflow"],
        job: collector["job"],
        command: collector["command"],
      },
    } as const satisfies TestScenario;
  });
};

type ScenarioBaseline = Pick<TestScenario, "file" | "type">;

export const scenarioLedgerGrowth = (
  previous: readonly ScenarioBaseline[],
  current: readonly ScenarioBaseline[],
): readonly string[] => {
  const baseline = new Map(previous.map((entry) => [entry.file, entry.type]));
  return current
    .flatMap(({ file, type }) => {
      const previousType = baseline.get(file);
      if (previousType === undefined) {
        return [`scenario ledger is shrink-only: added ${file}`];
      }
      if (type === "non-gating" && previousType !== "non-gating") {
        return [
          `scenario ledger cannot weaken ${file}: ${previousType} -> ${type}`,
        ];
      }
      return [];
    })
    .toSorted(compareCodeUnit);
};

const readNonGatingLedger = (): readonly TestScenario[] =>
  parseScenarioLedger(readJson(NON_GATING_LEDGER));

const scenarioLedgerBaseline = (): readonly ScenarioBaseline[] => {
  const options = { cwd: ROOT, encoding: "utf-8" } as const;
  const mergeBase = execFileSync(
    "git",
    ["merge-base", "origin/main", "HEAD"],
    options,
  ).trim();
  const inBase = execFileSync(
    "git",
    ["ls-tree", "--name-only", mergeBase, "--", NON_GATING_LEDGER],
    options,
  ).trim();
  if (inBase !== NON_GATING_LEDGER) {
    // The initial inventory becomes the merge-base ledger when this guard lands.
    return readNonGatingLedger().map(({ file, type }) => ({ file, type }));
  }
  const reference = mergeBase;
  const value: unknown = JSON.parse(
    execFileSync("git", ["show", `${reference}:${NON_GATING_LEDGER}`], options),
  );
  if (!Array.isArray(value)) {
    panic(`${NON_GATING_LEDGER} baseline must be an array`);
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry["file"] !== "string") {
      panic(`${NON_GATING_LEDGER} baseline contains an invalid file`);
    }
    // Existing ledger kinds remain part of the shrink-only boundary.
    const type = "type" in entry ? entry["type"] : "non-gating";
    if (
      type !== "non-gating" &&
      type !== "executed" &&
      type !== "pinned-collector"
    ) {
      panic(`${NON_GATING_LEDGER} baseline contains an invalid kind`);
    }
    return { file: entry["file"], type };
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

type RegistrationName =
  | { readonly type: "resolved"; readonly name: string }
  | { readonly type: "unresolved"; readonly reason: string };

const registrationName = (
  expression: ts.Expression,
  aliases: ReadonlyMap<string, RegistrationName>,
): RegistrationName | undefined => {
  if (ts.isCallExpression(expression)) {
    return registrationName(expression.expression, aliases);
  }
  if (ts.isIdentifier(expression)) {
    return aliases.get(expression.text);
  }
  if (
    !ts.isPropertyAccessExpression(expression) &&
    !ts.isElementAccessExpression(expression)
  ) {
    return undefined;
  }
  const base = registrationName(expression.expression, aliases);
  if (base === undefined || base.type === "unresolved") {
    return base;
  }
  const property = literalMemberName(expression);
  if (property === undefined) {
    return {
      type: "unresolved",
      reason: "computed registration key is not literal",
    };
  }
  if (base.name === TEST_RUNNER_NAMESPACE || base.name === "test") {
    if (TEST_REGISTRATIONS.some((candidate) => candidate === property)) {
      return { type: "resolved", name: property === "it" ? "test" : property };
    }
    if (base.name === TEST_RUNNER_NAMESPACE) {
      return undefined;
    }
  }
  return REGISTRATION_MODIFIERS.has(property)
    ? { type: "resolved", name: `${base.name}.${property}` }
    : undefined;
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

type RegistrationIdentityOptions = {
  readonly file: string;
  readonly title: string | undefined;
  readonly suites: readonly string[];
  readonly source: ts.SourceFile;
  readonly node: ts.CallExpression;
};

const registrationIdentity = ({
  file,
  title,
  suites,
  source,
  node,
}: RegistrationIdentityOptions): string => {
  if (title !== undefined) {
    return `${file}::${[...suites, title].join(" > ")}`;
  }
  const { line, character } = source.getLineAndCharacterOfPosition(
    node.getStart(source),
  );
  return `${file}::<dynamic title at ${line + 1}:${character + 1}>`;
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
const assignedRegistrationAlias = (
  node: ts.Node,
  aliases: ReadonlyMap<string, RegistrationName>,
) => {
  if (
    !ts.isBinaryExpression(node) ||
    !ts.isIdentifier(node.left) ||
    node.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
    node.operatorToken.kind > ts.SyntaxKind.LastAssignment ||
    registrationName(node.right, aliases) === undefined
  ) {
    return undefined;
  }
  return node.left.text;
};

const registrationAliases = (source: ts.SourceFile) => {
  const aliases = new Map<string, RegistrationName>();
  const declarations = new Map<string, ts.VariableDeclaration>();
  const invalidBindings: { name: string; reason: string }[] = [];
  for (const registration of TEST_REGISTRATIONS) {
    aliases.set(registration, {
      type: "resolved",
      name: registration === "it" ? "test" : registration,
    });
  }

  const discoverAliases = (node: ts.Node): void => {
    const assigned = assignedRegistrationAlias(node, aliases);
    if (assigned !== undefined) {
      aliases.set(assigned, {
        type: "unresolved",
        reason: `assigned registration alias ${assigned}`,
      });
    }
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
            aliases.set(element.name.text, {
              type: "resolved",
              name: imported === "it" ? "test" : imported,
            });
          }
        }
      } else if (isTestRunnerNamespaceImport(bindings, node.moduleSpecifier)) {
        aliases.set(bindings.name.text, {
          type: "resolved",
          name: TEST_RUNNER_NAMESPACE,
        });
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
        declarations.set(node.name.text, node);
      }
      if (ts.isConditionalExpression(node.initializer)) {
        const whenTrue = registrationName(node.initializer.whenTrue, aliases);
        const whenFalse = registrationName(node.initializer.whenFalse, aliases);
        if (whenTrue !== undefined && whenFalse !== undefined) {
          declarations.set(node.name.text, node);
          if (whenTrue.type === "unresolved") {
            aliases.set(node.name.text, whenTrue);
          } else if (whenFalse.type === "unresolved") {
            aliases.set(node.name.text, whenFalse);
          } else {
            aliases.set(node.name.text, {
              type: "resolved",
              name: `${whenTrue.name}|${whenFalse.name}|conditional`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, discoverAliases);
  };
  discoverAliases(source);
  for (const [name] of aliases) {
    const declaration = declarations.get(name);
    const mutable =
      declaration !== undefined &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.getFirstToken(source)?.kind !==
        ts.SyntaxKind.ConstKeyword;
    let reason: string | undefined;
    if (mutable) {
      reason = `mutable registration alias ${name}`;
    } else if (writesConfigBinding(source, name)) {
      reason = `assigned registration alias ${name}`;
    }
    if (reason !== undefined) {
      aliases.set(name, { type: "unresolved", reason });
      invalidBindings.push({ name, reason });
    }
  }
  return { aliases, invalidBindings };
};

const literalWindowsSkip = (expression: ts.Expression): boolean => {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) {
    return false;
  }
  const condition = expression.arguments.at(0);
  if (
    condition === undefined ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
    !ts.isPropertyAccessExpression(condition.left) ||
    !ts.isIdentifier(condition.left.expression) ||
    condition.left.expression.text !== "process" ||
    condition.left.name.text !== "platform" ||
    !ts.isStringLiteral(condition.right) ||
    condition.right.text !== "win32"
  ) {
    return false;
  }
  return true;
};

type PlatformSkipMetadataOptions = {
  readonly name: string;
  readonly expression: ts.Expression;
  readonly callbackDisabled: boolean;
  readonly conditionallyRegistered: boolean;
};

const platformSkipMetadata = ({
  name,
  expression,
  callbackDisabled,
  conditionallyRegistered,
}: PlatformSkipMetadataOptions) =>
  name === "test.skipIf" &&
  !callbackDisabled &&
  !conditionallyRegistered &&
  literalWindowsSkip(expression)
    ? { skippedOn: ["win32"] as const }
    : {};

export const parseTestRegistrations = (
  file: string,
  sourceText: string,
): RegistrationFinding[] => {
  const source = parseTypeScript(file, sourceText);
  const { aliases, invalidBindings } = registrationAliases(source);

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

  const findings: RegistrationFinding[] = invalidBindings.map(
    ({ name, reason }) => ({
      type: "unresolved",
      identity: `${file}::<registration alias ${name}>`,
      reason,
    }),
  );
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
        ts.isPropertyAccessExpression(node.parent) ||
        ts.isElementAccessExpression(node.parent)) &&
      node.parent.expression === node
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    const registration = registrationName(node.expression, aliases);
    if (registration === undefined) {
      ts.forEachChild(node, visit);
      return;
    }
    if (registration.type === "unresolved") {
      const title = registrationTitle(node.arguments.at(0), constantTitles);
      const identity = registrationIdentity({
        file,
        title,
        suites,
        source,
        node,
      });
      findings.push({
        type: "unresolved",
        identity,
        reason: registration.reason,
      });
      ts.forEachChild(node, visit);
      return;
    }
    const { name } = registration;
    const hook = /^(?:after|before)(?:All|Each)$/u.test(name);
    const title = hook
      ? `hook:${name}`
      : registrationTitle(node.arguments.at(0), constantTitles);
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
    const conditionallyRegistered = isConditionallyRegistered(node);
    const isDisabled =
      calleeDisabled || callbackDisabled || conditionallyRegistered;
    const platformMetadata = platformSkipMetadata({
      name,
      expression: node.expression,
      callbackDisabled,
      conditionallyRegistered,
    });
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
        findings.push({
          identity: registrationIdentity({ file, title, suites, source, node }),
          ...(managedServiceGate === undefined ? {} : { managedServiceGate }),
          type: isOnly ? "only" : "disabled",
        });
      }
      ts.forEachChild(node, visit);
      return;
    }
    const identity = registrationIdentity({
      file,
      title,
      suites,
      source,
      node,
    });
    if (isOnly) {
      findings.push({ identity, type: "only" });
    }
    if (isDisabled) {
      findings.push(
        managedServiceGate === undefined
          ? {
              identity,
              type: "disabled",
              ...platformMetadata,
            }
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

// Explicit Bash workflow steps use errexit and pipefail. Package scripts run with
// neither errexit nor pipefail: only the last statement sets their status, and
// a runner piped into another command cannot fail them.
type ShellPropagation = {
  readonly pipefail: boolean;
  readonly errexit: boolean;
};

type GatingCommand = {
  readonly workingDirectory?: string;
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

const capturedVariableChanges = (token: ShellToken, name: string): boolean =>
  token.value.startsWith(`${name}=`) ||
  token.value.startsWith(`${name}+=`) ||
  token.value.startsWith(`${name}[`) ||
  token.value.includes("$(") ||
  token.value.includes("`") ||
  token.value.includes(`\${${name}=`) ||
  token.value.includes(`\${${name}:=`);

const unsupportedCaptureDiagnostic = ({ role, value }: ShellToken): boolean =>
  role === "command" &&
  (SHELL_CONTEXT_MUTATORS.has(value) ||
    [
      "set",
      "unset",
      "read",
      "declare",
      "typeset",
      "local",
      "readonly",
      "export",
      "let",
      "printf",
    ].includes(value));

type CapturedStatusExitOptions = {
  readonly tokens: readonly ShellToken[];
  readonly cursor: number;
  readonly name: string;
};

const capturedStatusExitEnd = ({
  tokens,
  cursor,
  name,
}: CapturedStatusExitOptions): number | undefined => {
  if (!separatorToken(tokens[cursor - 1])) {
    return undefined;
  }
  const status = tokens[cursor + 1];
  if (
    status?.role !== "argument" ||
    ![`$${name}`, `\${${name}}`].includes(status.value)
  ) {
    return undefined;
  }
  let end = cursor + 2;
  while (separatorToken(tokens[end])) {
    end += 1;
  }
  return tokens[end]?.role === "operator" && tokens[end]?.value === "}"
    ? end + 1
    : undefined;
};

const capturedFailureFallbackEnd = (
  tokens: readonly ShellToken[],
  start: number,
): number | undefined => {
  let first = start;
  while (tokens[first]?.role === "operator" && tokens[first]?.value === "\n") {
    first += 1;
  }
  const capture = tokens[first];
  const name =
    capture?.role === "assignment"
      ? /^([A-Za-z_][A-Za-z0-9_]*)=\$\?$/u.exec(capture.value)?.[1]
      : undefined;
  if (name === undefined || !separatorToken(tokens[first + 1])) {
    return undefined;
  }
  for (let cursor = first + 2; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (
      token === undefined ||
      capturedVariableChanges(token, name) ||
      unsupportedCaptureDiagnostic(token)
    ) {
      return undefined;
    }
    if (token.role === "operator" && ![";", "\n", "||"].includes(token.value)) {
      return undefined;
    }
    if (token.role === "operator" && token.value === "||") {
      const fallback = tokens[cursor + 1];
      if (
        fallback?.role !== "command" ||
        fallback.value !== "true" ||
        !separatorToken(tokens[cursor + 2])
      ) {
        return undefined;
      }
      cursor += 1;
      continue;
    }
    if (token.role !== "command" || token.value !== "exit") {
      continue;
    }
    return capturedStatusExitEnd({ tokens, cursor, name });
  }
  return undefined;
};

type LiteralFailureFallbackOptions = {
  readonly tokens: readonly ShellToken[];
  readonly start: number;
  readonly grouped: boolean;
};

const literalFailureFallbackEnd = ({
  tokens,
  start,
  grouped,
}: LiteralFailureFallbackOptions): number | undefined => {
  let cursor = start;
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
  return (
    (grouped ? capturedFailureFallbackEnd(tokens, cursor) : undefined) ??
    literalFailureFallbackEnd({ tokens, start: cursor, grouped })
  );
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

type InvocationDirectoryOptions = ShellInvocation & {
  readonly workingDirectory?: string;
  readonly propagation?: ShellPropagation;
};

const literalDirectory = (
  directory: unknown,
  base: string,
): string | undefined => {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory === "-" ||
    /[~*?[\]{}]/u.test(directory) ||
    !literalShellWord(directory) ||
    directory.includes("${{") ||
    path.posix.isAbsolute(directory)
  ) {
    return undefined;
  }
  const resolved = path.posix.normalize(path.posix.join(base, directory));
  return resolved === ".." || resolved.startsWith("../") ? undefined : resolved;
};

type EffectiveWorkingDirectoryOptions = {
  readonly root: Record<string, unknown> | undefined;
  readonly job: Record<string, unknown>;
  readonly step: Record<string, unknown>;
};

const effectiveWorkingDirectory = ({
  root,
  job,
  step,
}: EffectiveWorkingDirectoryOptions): string | undefined =>
  literalDirectory(
    step["working-directory"] ??
      workflowRecord(workflowRecord(job["defaults"])?.["run"])?.[
        "working-directory"
      ] ??
      workflowRecord(workflowRecord(root?.["defaults"])?.["run"])?.[
        "working-directory"
      ] ??
      ".",
    ".",
  );

const invocationWorkingDirectory = ({
  tokens,
  words,
  index,
  workingDirectory = ".",
  propagation = { errexit: true, pipefail: true },
}: InvocationDirectoryOptions): string | undefined => {
  let directory = workingDirectory;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (tokens[cursor]?.role !== "command") {
      continue;
    }
    if (words[cursor] === "pushd" || words[cursor] === "popd") {
      return undefined;
    }
    if (words[cursor] !== "cd") {
      continue;
    }
    const arguments_ = shellCommandSpan(tokens, cursor + 1).words;
    if (
      arguments_.length !== 1 ||
      approvedInvocationFailure({
        tokens,
        index: cursor,
        propagation,
        knownRunner: directTestRunner,
      }) !== undefined
    ) {
      return undefined;
    }
    const resolved = literalDirectory(arguments_.at(0), directory);
    if (resolved === undefined) {
      return undefined;
    }
    directory = resolved;
  }
  return directory;
};

type PackageInvocationOptions = ShellInvocation & {
  readonly packageDirectory: string;
  readonly packageName: string;
  readonly scriptName: string;
  readonly workingDirectory?: string;
  readonly propagation?: ShellPropagation;
};

const packageInvocationEnd = ({
  words,
  tokens,
  index,
  packageDirectory,
  packageName,
  scriptName,
  workingDirectory = ".",
  propagation,
}: PackageInvocationOptions): number | undefined => {
  if (words[index] !== "bun") {
    return undefined;
  }
  const directory = invocationWorkingDirectory({
    words,
    tokens,
    index,
    workingDirectory,
    ...(propagation === undefined ? {} : { propagation }),
  });
  if (directory === undefined) {
    return undefined;
  }
  if (
    directory === "." &&
    words[index + 1] === "--filter" &&
    words[index + 2] === packageName &&
    words[index + 3] === scriptName
  ) {
    return index + 4;
  }
  const offset = words[index + 1] === "run" ? 2 : 1;
  if (
    words[index + offset] === "--cwd" &&
    literalDirectory(words[index + offset + 1], directory) ===
      packageDirectory &&
    words[index + offset + 2] === scriptName
  ) {
    return index + offset + 3;
  }
  return directory === packageDirectory &&
    words[index + 1] === "run" &&
    words[index + 2] === scriptName
    ? index + 3
    : undefined;
};

type GatingArgumentsOptions = {
  readonly workingDirectory?: string;
  readonly onDirectory?: (directory: string, arguments_: string[]) => void;
  readonly command: string;
  readonly invocationEnd: (invocation: ShellInvocation) => number | undefined;
  readonly onUnresolved?: (reason: string) => void;
  readonly propagation?: ShellPropagation;
};

const gatingArguments = ({
  workingDirectory = ".",
  onDirectory,
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
    const directory = invocationWorkingDirectory({
      words,
      tokens,
      index,
      workingDirectory,
      ...(propagation === undefined ? {} : { propagation }),
    });
    if (directory === undefined) {
      onUnresolved?.("runner working-directory: unresolved directory change");
      continue;
    }
    const arguments_ = shellCommandSpan(tokens, end).words;
    invocations.push(arguments_);
    onDirectory?.(directory, arguments_);
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
  readonly workingDirectory: string;
  readonly command: string;
  readonly packageScript: boolean;
  readonly propagation: ShellPropagation;
};

type RootScriptExpansionOptions = {
  readonly workingDirectory?: string;
  readonly command: string;
  readonly scripts: PackageScripts;
  readonly propagation: ShellPropagation;
  readonly visited?: ReadonlySet<string>;
};

const expandRootScripts = ({
  workingDirectory = ".",
  command,
  scripts,
  propagation,
  visited = new Set(),
}: RootScriptExpansionOptions): RootCommand[] => {
  const packageScript = visited.size > 0;
  const expanded: RootCommand[] = [
    { command, packageScript, propagation, workingDirectory },
  ];
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
      workingDirectory,
      invocationEnd: ({ words, tokens, index }) =>
        words[index] === "bun" &&
        words[index + 1] === "run" &&
        words[index + 2] === name &&
        invocationWorkingDirectory({
          words,
          tokens,
          index,
          workingDirectory,
          propagation,
        }) === "."
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
  const cacheKey = `${workflowCommand.workingDirectory ?? "."}:${workflowCommand.propagation.errexit}:${workflowCommand.propagation.pipefail}:${workflowCommand.command}`;
  const cached = commands.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const expanded = expandRootScripts({
    command: workflowCommand.command,
    workingDirectory: workflowCommand.workingDirectory ?? ".",
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
  const values = raw.startsWith("${{") ? [] : [raw];
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
      const shard = run.environment["SHARD"];
      if (typeof shard !== "string" || shard.startsWith("${{")) {
        return {
          type: "unresolved",
          reason:
            "runner selection: shard environment has no executable matrix leg",
        };
      }
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
    workingDirectory: run.workingDirectory ?? ".",
    propagation: run.propagation,
    invocationEnd: ({ words, tokens, index }) =>
      invocationWorkingDirectory({
        words,
        tokens,
        index,
        workingDirectory: run.workingDirectory ?? ".",
        propagation: run.propagation,
      }) === "." &&
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
    for (const {
      command,
      packageScript,
      propagation,
      workingDirectory,
    } of commands.flatMap((workflowCommand) =>
      rootScriptCommands(workflowCommand, rootScripts),
    )) {
      const conditions: string[] = [];
      const invocations = gatingArguments({
        command,
        workingDirectory,
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
            workingDirectory,
            propagation,
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
    commandMatches: ({
      command: candidate,
      propagation,
      workingDirectory = ".",
    }) =>
      shellInvocationGates({
        command: candidate,
        propagation,
        onUnresolved: (reason) => {
          condition ??= reason;
        },
        matches: ({ words, tokens, index }) =>
          invocationWorkingDirectory({
            words,
            tokens,
            index,
            workingDirectory,
            propagation,
          }) === "." &&
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
    commandMatches: ({
      command: candidate,
      propagation,
      workingDirectory = ".",
    }) =>
      shellInvocationGates({
        command: candidate,
        propagation,
        onUnresolved: (reason) => {
          condition ??= reason;
        },
        matches: ({ words, tokens, index }) =>
          invocationWorkingDirectory({
            words,
            tokens,
            index,
            workingDirectory,
            propagation,
          }) === "." &&
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
  readonly workingDirectory?: string;
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

type PackageRunnerCollectionOptions = PackageTestCollectionOptions & {
  readonly invocation: ShellInvocation;
  readonly directory: string;
};

const packageRunnerCollectionFailure = ({
  candidate,
  packageDirectory,
  scripts,
  scriptName = "test",
  visited = new Set(),
  forwardedArguments = [],
  invocation: { words, tokens, index },
  directory,
}: PackageRunnerCollectionOptions): string | undefined => {
  const relativeCandidate = repoRelativePath(directory, candidate);
  if (relativeCandidate === ".." || relativeCandidate.startsWith("../")) {
    return "runner working-directory: file is outside the collector directory";
  }
  const delegatedScript = words[index + 2];
  if (words[index + 1] === "run" && delegatedScript?.startsWith("test:")) {
    if (directory !== packageDirectory) {
      return "runner working-directory: delegated script is outside its package";
    }
    const { words: delegatedArguments, end: boundary } = shellCommandSpan(
      tokens,
      index + 3,
    );
    const delegatedFailure = packageTestCollectionFailure({
      candidate,
      packageDirectory,
      scriptName: delegatedScript,
      workingDirectory: directory,
      scripts,
      forwardedArguments: [
        ...(delegatedArguments.at(0) === "--"
          ? delegatedArguments.slice(1)
          : delegatedArguments),
        ...(boundary === -1 ? forwardedArguments : []),
      ],
      visited: new Set([...visited, scriptName]),
    });
    return delegatedFailure;
  }
  if (words[index + 1]?.endsWith("scripts/run-tests.ts")) {
    if (
      literalDirectory(words[index + 1], directory) !==
      path.posix.join(packageDirectory, "scripts/run-tests.ts")
    ) {
      return "runner working-directory: wrapper path does not resolve to its owner";
    }
    const { words: remaining, end: boundary } = shellCommandSpan(
      tokens,
      index + 2,
    );
    const failure = bunArgumentCollectionFailure(relativeCandidate, [
      ...remaining,
      ...(boundary === -1 ? forwardedArguments : []),
    ]);
    const wrapperFailure =
      failure ?? testWrapperCollectionFailure(packageDirectory, candidate);
    return wrapperFailure;
  }
  if (words[index + 1] !== "test") {
    return "runner command: unsupported package runner";
  }
  const { words: remaining, end } = shellCommandSpan(tokens, index + 2);
  const arguments_ = [...remaining, ...(end === -1 ? forwardedArguments : [])];
  const failure = bunArgumentCollectionFailure(relativeCandidate, arguments_);
  return failure;
};

export const packageTestCollectionFailure = ({
  workingDirectory,
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
    const directory = invocationWorkingDirectory({
      words,
      tokens,
      index,
      workingDirectory: workingDirectory ?? packageDirectory,
      propagation: PACKAGE_SCRIPT_PROPAGATION,
    });
    if (directory === undefined) {
      firstFailure ??= "runner working-directory: unresolved directory change";
      continue;
    }
    const failure = packageRunnerCollectionFailure({
      candidate,
      packageDirectory,
      scripts,
      scriptName,
      visited,
      forwardedArguments,
      invocation: { words, tokens, index },
      directory,
    });
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

type ExecutableMatrixLegsOptions = {
  readonly job: Record<string, unknown>;
  readonly root: Record<string, unknown>;
  readonly registry: readonly TrustedOutputProducer[];
};

const executableMatrixLegs = ({
  job,
  root,
  registry,
}: ExecutableMatrixLegsOptions) => {
  const matrix = workflowRecord(job["strategy"])?.["matrix"];
  if (matrix === undefined) {
    return { type: "resolved", legs: [{}] } as const;
  }
  if (isRecord(matrix) && !hasDynamicMatrix(job)) {
    return { type: "resolved", legs: matrixLegs(job) } as const;
  }
  if (typeof matrix !== "string") {
    return {
      type: "unresolved",
      reason:
        "job matrix: selection is not literal or a registered shard producer",
    } as const;
  }
  const reference =
    /^fromJSON\(needs\.(?<job>[\w-]+)\.outputs\.(?<output>[\w-]+)\)$/u.exec(
      conditionExpression(matrix),
    )?.groups;
  const jobName = reference?.["job"];
  const output = reference?.["output"];
  if (jobName === undefined || output === undefined) {
    return {
      type: "unresolved",
      reason: "job matrix: shard selection expression is unsupported",
    } as const;
  }
  const jobs = workflowRecord(root["jobs"]);
  const alias = workflowRecord(workflowRecord(jobs?.[jobName])?.["outputs"])?.[
    output
  ];
  const exported =
    typeof alias === "string"
      ? /^steps\.(?<step>[\w-]+)\.outputs\.(?<output>[\w-]+)$/u.exec(
          conditionExpression(alias),
        )?.groups
      : undefined;
  const producer = registry.find(
    (entry) =>
      entry.job === jobName &&
      entry.stepId === exported?.["step"] &&
      entry.outputNames.includes(exported?.["output"] ?? "") &&
      entry.declaredShards !== undefined,
  );
  if (
    producer?.declaredShards === undefined ||
    producer.declaredShards.length === 0 ||
    !producer.declaredShards.every((shard) =>
      Object.hasOwn(TEST_JOB_SHARDS, shard),
    )
  ) {
    return {
      type: "unresolved",
      reason: "job matrix: registered producer has no proven shard set",
    } as const;
  }
  return {
    type: "resolved",
    legs: producer.declaredShards.map((shard) => ({ shard })),
  } as const;
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
  readonly trustedOutputs: ReadonlySet<string>;
};

const executableCondition = ({
  condition,
  declaredInputs,
  dynamicMatrix,
  trustedOutputs,
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
      /^steps\.[\w-]+\.(?:conclusion|outcome)$/u.test(reference) ||
      /^needs\.[\w-]+\.result$/u.test(reference) ||
      trustedOutputs.has(reference)
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
      unresolved.length === 0 && (evaluated === true || !staticallyFalse),
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
    return {
      type: "supported",
      propagation: { errexit: true, pipefail: false },
    };
  }
  if (
    platforms.every(
      (value) =>
        typeof value === "string" &&
        /^(?:ubuntu|linux|macos)(?:-|$)/u.test(value),
    )
  ) {
    return {
      type: "supported",
      propagation: { errexit: true, pipefail: false },
    };
  }
  return {
    type: "unsupported",
    name: typeof runsOn === "string" ? `default on ${runsOn}` : "default shell",
  };
};

const hasTestCollector = (command: string): boolean => {
  const tokens = shellTokens(command);
  const words = tokens.map(({ value }) => value);
  return tokens.some(
    (token, index) =>
      token.role === "command" &&
      (directTestRunner({ tokens, words, index }) ||
        (token.value === "bun" &&
          shellCommandSpan(tokens, index + 1).words.some(
            (word) =>
              word === "test" ||
              word.startsWith("test:") ||
              isTypeScriptTest(word),
          ))),
  );
};

const declaredSelectionOutputs = (
  source: string,
  outputNames: readonly string[],
) => {
  const sources = [source];
  for (const match of source.matchAll(/\bscripts\/[\w./-]+\.ts\b/gu)) {
    const script = match[0];
    if (existsSync(path.join(ROOT, script))) {
      sources.push(readFileSync(path.join(ROOT, script), "utf-8"));
    }
  }
  const declarations = sources.join("\n");
  return new Set(
    outputNames.filter((name) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(
        `(?:["'\\x60]${escaped}(?:=|<<|["'\\x60])|\\b${escaped}=)`,
        "u",
      ).test(declarations);
    }),
  );
};

const registeredJobOutputs = (
  jobs: Record<string, unknown>,
  stepReferences: ReadonlyMap<string, ReadonlySet<string>>,
) => {
  const jobReferences = new Set<string>();
  for (const [name, value] of Object.entries(jobs)) {
    const outputs = workflowRecord(workflowRecord(value)?.["outputs"]) ?? {};
    for (const [output, expression] of Object.entries(outputs)) {
      if (typeof expression !== "string") {
        continue;
      }
      const references = referencedContexts(expression).filter((reference) =>
        reference.includes(".outputs."),
      );
      if (
        references.length > 0 &&
        references.every((reference) =>
          stepReferences.get(name)?.has(reference),
        )
      ) {
        jobReferences.add(`needs.${name}.outputs.${output}`);
      }
    }
  }
  return jobReferences;
};

export const referencedCollectorOutputs = (
  workflow: unknown,
): ReadonlySet<string> => {
  const jobs = workflowRecord(workflowRecord(workflow)?.["jobs"]) ?? {};
  const needed = new Set<string>();
  const collect = (jobName: string, expression: unknown): void => {
    if (typeof expression !== "string") {
      return;
    }
    for (const reference of referencedContexts(expression)) {
      const step = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/u.exec(reference);
      const stepId = step?.at(1);
      const stepOutput = step?.at(2);
      if (stepId !== undefined && stepOutput !== undefined) {
        needed.add(`${jobName}/${stepId}.outputs.${stepOutput}`);
      }
      const jobOutput = /^needs\.([\w-]+)\.outputs\.([\w-]+)$/u.exec(reference);
      const producerJob = jobOutput?.at(1);
      const output = jobOutput?.at(2);
      if (producerJob !== undefined && output !== undefined) {
        const exports = workflowRecord(
          workflowRecord(jobs[producerJob])?.["outputs"],
        );
        const value = exports?.[output];
        if (typeof value === "string") {
          for (const dependency of referencedContexts(value)) {
            const match = /^steps\.([\w-]+)\.outputs\.([\w-]+)$/u.exec(
              dependency,
            );
            const id = match?.at(1);
            const name = match?.at(2);
            if (id !== undefined && name !== undefined) {
              needed.add(`${producerJob}/${id}.outputs.${name}`);
            }
          }
        }
      }
    }
  };
  for (const [name, rawJob] of Object.entries(jobs)) {
    const job = workflowRecord(rawJob);
    if (!Array.isArray(job?.["steps"])) {
      continue;
    }
    for (const step of flattenWorkflowSteps(job["steps"])) {
      const command = step["run"];
      if (
        typeof command !== "string" ||
        !(
          hasTestCollector(command) ||
          command.includes("run-in-image.sh") ||
          command.includes("scripts/run-unlisted-script-tests.ts")
        )
      ) {
        continue;
      }
      collect(name, job["if"]);
      collect(name, workflowRecord(job["strategy"])?.["matrix"]);
      collect(name, step["if"]);
    }
  }
  return needed;
};

type ValidateTrustedOutputProducersOptions = {
  readonly workflow: unknown;
  readonly registry: readonly TrustedOutputProducer[];
  readonly scope?: "repository" | "present-jobs";
};

export const validateTrustedOutputProducers = ({
  workflow,
  registry,
  scope = "repository",
}: ValidateTrustedOutputProducersOptions) => {
  const root = workflowRecord(workflow);
  const jobs = workflowRecord(root?.["jobs"]) ?? {};
  const resultNeeds = workflowRecord(jobs["ci-result"])?.["needs"];
  const requiredJobs = new Set(
    Array.isArray(resultNeeds) ? resultNeeds : [resultNeeds],
  );
  const findings: string[] = [];
  const used = referencedCollectorOutputs(workflow);
  const stepReferences = new Map<string, Set<string>>();
  for (const producer of registry) {
    const label = `trusted output producer: ${producer.job}/${producer.stepId}`;
    if (producer.workflow !== ".github/workflows/ci.yml") {
      findings.push(`${label} has unsupported workflow ${producer.workflow}`);
      continue;
    }
    const job = workflowRecord(jobs[producer.job]);
    if (job === undefined) {
      if (scope === "repository" || requiredJobs.has(producer.job)) {
        findings.push(`${label} job is missing`);
      }
      continue;
    }
    if (
      !isTypeScriptTest(producer.proofTest) ||
      !existsSync(path.join(ROOT, producer.proofTest))
    ) {
      findings.push(`${label} proof test is missing: ${producer.proofTest}`);
      continue;
    }
    const steps = Array.isArray(job["steps"])
      ? flattenWorkflowSteps(job["steps"])
      : [];
    const matches = steps.filter((step) => step["id"] === producer.stepId);
    const step = matches.at(0);
    if (matches.length !== 1 || step === undefined) {
      findings.push(`${label} step is missing or duplicated`);
      continue;
    }
    const source =
      typeof step["run"] === "string"
        ? step["run"]
        : workflowRecord(step["with"])?.["script"];
    if (typeof source !== "string") {
      findings.push(`${label} output declaration is unavailable`);
      continue;
    }
    let available: ReadonlySet<string>;
    switch (producer.semantics) {
      case "selection": {
        available = declaredSelectionOutputs(source, producer.outputNames);
        break;
      }
      case "content-reuse":
        if (
          source.trim() !==
          `bun scripts/ci-static-checks.ts resolve ${producer.job}`
        ) {
          findings.push(`${label} content-reuse command changed`);
          continue;
        }
        available = new Set(
          classifiedChecks(workflow, producer.job)
            .filter(
              (check) =>
                workflowRecord(check["env"])?.["CI_CHECK_KIND"] === "STATIC",
            )
            .flatMap((check) =>
              typeof check["id"] === "string"
                ? [staticReuseOutputName(check["id"])]
                : [],
            ),
        );
        break;
      default:
        return panic(
          `Unrecognized output producer semantics: ${String(producer.semantics satisfies never)}`,
        );
    }
    const references = stepReferences.get(producer.job) ?? new Set<string>();
    for (const output of producer.outputNames) {
      if (!used.has(`${producer.job}/${producer.stepId}.outputs.${output}`)) {
        findings.push(
          `${label} output has no collector condition reader: ${output}`,
        );
        continue;
      }
      if (!available.has(output)) {
        findings.push(`${label} output is missing or renamed: ${output}`);
        continue;
      }
      references.add(`steps.${producer.stepId}.outputs.${output}`);
    }
    stepReferences.set(producer.job, references);
  }
  const jobReferences = registeredJobOutputs(jobs, stepReferences);
  const references = new Map(
    Object.keys(jobs).map(
      (name) =>
        [
          name,
          new Set([...jobReferences, ...(stepReferences.get(name) ?? [])]),
        ] as const,
    ),
  );
  return { references, findings };
};

export type GatingWorkflowAnalysis = {
  readonly findings: readonly string[];
  readonly jobs: ReadonlyMap<string, readonly GatingCommand[]>;
};

const analyzeWorkflowWithProducerDeclarations = (
  workflow: unknown,
  registry: readonly TrustedOutputProducer[] = TRUSTED_OUTPUT_PRODUCERS,
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
  const registered = validateTrustedOutputProducers({
    workflow,
    registry,
    scope: "present-jobs",
  });
  const findings = new Set(registered.findings);
  const gating = new Map<string, readonly GatingCommand[]>();
  for (const name of names) {
    const job = workflowRecord(jobs[name]);
    if (job === undefined) {
      continue;
    }
    if (!Array.isArray(job["steps"])) {
      continue;
    }
    const matrixResolution = executableMatrixLegs({
      job,
      root: root ?? {},
      registry,
    });
    if (matrixResolution.type === "unresolved") {
      findings.add(`job condition: ${name} ${matrixResolution.reason}`);
      continue;
    }
    const dynamicMatrix = false;
    const legs = matrixResolution.legs;
    const commands = flattenWorkflowSteps(job["steps"]).flatMap(
      (step, stepIndex) => {
        const command = step["run"];
        if (typeof command !== "string") {
          return [];
        }
        const executingLegs = new Map<string, MatrixLeg>();
        const unresolvedContexts = new Set<string>();
        for (const eventName of GATING_EVENTS) {
          for (const matrix of legs) {
            const contextOptions = { eventName, inputs, matrix, variables };
            const jobCondition = executableCondition({
              ...contextOptions,
              condition: job["if"],
              declaredInputs,
              dynamicMatrix,
              trustedOutputs:
                registered.references.get(name) ?? new Set<string>(),
            });
            const stepCondition = executableCondition({
              ...contextOptions,
              condition: step["if"],
              declaredInputs,
              dynamicMatrix,
              trustedOutputs:
                registered.references.get(name) ?? new Set<string>(),
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
              executingLegs.set(JSON.stringify(matrix), matrix);
            }
          }
        }
        if (executingLegs.size === 0) {
          for (const context of unresolvedContexts) {
            findings.add(
              `job condition: ${name}/step-${stepIndex + 1} has unresolved context ${context}`,
            );
          }
        }
        if (executingLegs.size === 0) {
          return [];
        }
        const shell = effectiveWorkflowShell({
          root,
          job,
          step,
          legs: [...executingLegs.values()],
        });
        if (shell.type === "unsupported") {
          if (hasTestCollector(command)) {
            findings.add(
              `job condition: ${name}/step-${stepIndex + 1} uses unsupported shell ${shell.name}`,
            );
          }
          return [];
        }
        const workingDirectory = effectiveWorkingDirectory({ root, job, step });
        if (workingDirectory === undefined) {
          findings.add(
            `job condition: ${name}/step-${stepIndex + 1} has unresolved working-directory`,
          );
          return [];
        }
        const environment = {
          ...workflowRecord(root?.["env"]),
          ...workflowRecord(job["env"]),
          ...workflowRecord(step["env"]),
        };
        return [...executingLegs.values()].map((leg) => ({
          command: executableShell(command),
          workingDirectory,
          environment: Object.fromEntries(
            Object.entries(environment).map(([key, value]) => [
              key,
              typeof value === "string" &&
              value.startsWith("${{") &&
              value.indexOf("}}") === value.length - 2 &&
              referencedContexts(value).every((reference) =>
                reference.startsWith("matrix."),
              )
                ? evaluate(
                    conditionExpression(value),
                    contextFromNested({ matrix: leg }),
                  )
                : value,
            ]),
          ),
          propagation: shell.propagation,
        }));
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

export const analyzeGatingWorkflow = (
  workflow: unknown,
  registry: readonly TrustedOutputProducer[] = TRUSTED_OUTPUT_PRODUCERS,
): GatingWorkflowAnalysis => {
  const workflowText = JSON.stringify(workflow);
  const jobs = workflowRecord(workflowRecord(workflow)?.["jobs"]) ?? {};
  const independent = analyzeWorkflowWithProducerDeclarations(workflow, []);
  const rejectedProofs: string[] = [];
  const creditedRegistry = registry.filter((producer) => {
    if (!(producer.job in jobs)) {
      return true;
    }
    const failure = firstCollectionFailure({
      file: producer.proofTest,
      scenarios: new Map(),
      topology: {
        workflow: workflowText,
        gatingJobs: independent.jobs,
        shardedPackages: new Set<string>(),
      },
    });
    if (failure === undefined) {
      return true;
    }
    rejectedProofs.push(
      `trusted output producer: ${producer.job}/${producer.stepId} proof test has no independent gating collector: ${producer.proofTest}; ${failure}`,
    );
    return false;
  });
  const analysis = analyzeWorkflowWithProducerDeclarations(
    workflow,
    creditedRegistry,
  );
  return {
    jobs: analysis.jobs,
    findings: [...new Set([...analysis.findings, ...rejectedProofs])].toSorted(
      compareCodeUnit,
    ),
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
  const plannedJob = workflowRecord(
    workflowRecord(workflowRecord(Bun.YAML.parse(workflow))?.["jobs"])?.[
      "ci-plan"
    ],
  );
  const planJob = Array.isArray(plannedJob?.["steps"])
    ? flattenWorkflowSteps(plannedJob["steps"])
        .flatMap((step) =>
          typeof step["run"] === "string" ? [step["run"]] : [],
        )
        .join("\n")
    : "";
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

const unwrapConfigExpression = (expression: ts.Expression): ts.Expression => {
  let node = expression;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
};

const writesConfigBinding = (source: ts.SourceFile, name: string): boolean => {
  let written = false;
  const mentions = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) {
      return node.text === name;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      return mentions(node.expression);
    }
    return ts.forEachChild(node, mentions) === true;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mentions(node.left)
    ) {
      written = true;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        node.operator,
      ) &&
      mentions(node.operand)
    ) {
      written = true;
    }
    if (ts.isDeleteExpression(node) && mentions(node.expression)) {
      written = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return written;
};

const isPlaywrightDefineConfig = (
  source: ts.SourceFile,
  callee: ts.Expression,
): boolean => {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@playwright/test" ||
      statement.importClause === undefined ||
      statement.importClause.phaseModifier !== undefined
    ) {
      continue;
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (
      ts.isNamedImports(bindings) &&
      ts.isIdentifier(callee) &&
      bindings.elements.some(
        (binding) =>
          !binding.isTypeOnly &&
          (binding.propertyName?.text ?? binding.name.text) ===
            "defineConfig" &&
          binding.name.text === callee.text &&
          !writesConfigBinding(source, binding.name.text),
      )
    ) {
      return true;
    }
    if (
      !ts.isNamespaceImport(bindings) ||
      (!ts.isPropertyAccessExpression(callee) &&
        !ts.isElementAccessExpression(callee))
    ) {
      continue;
    }
    const property = literalMemberName(callee);
    if (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === bindings.name.text &&
      property === "defineConfig" &&
      !writesConfigBinding(source, bindings.name.text)
    ) {
      return true;
    }
  }
  return false;
};

const importedConfigFile = (
  specifier: string,
  configFile: string,
): string | undefined => {
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(ROOT, configFile),
    { moduleResolution: ts.ModuleResolutionKind.Bundler },
    ts.sys,
  ).resolvedModule;
  return resolved === undefined
    ? undefined
    : repoRelativePath(ROOT, resolved.resolvedFileName);
};

type PlaywrightConfigFields =
  | { readonly type: "resolved"; readonly fields: Map<string, ts.Expression> }
  | { readonly type: "unresolved"; readonly field: string };

const playwrightConfigFields = ({
  configFile,
  source,
  readConfig,
  visited: visitedConfigs = new Set(),
}: PlaywrightConfigSource): PlaywrightConfigFields => {
  if (visitedConfigs.has(configFile)) {
    return { type: "unresolved", field: "cyclic configuration import" };
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
    return { type: "unresolved", field: "configuration object" };
  }
  const exportedExpression = unwrapConfigExpression(exported.expression);
  if (
    ts.isCallExpression(exportedExpression) &&
    !isPlaywrightDefineConfig(
      ast,
      unwrapConfigExpression(exportedExpression.expression),
    )
  ) {
    return {
      type: "unresolved",
      field:
        "exported factory (expected an immutable @playwright/test defineConfig import)",
    };
  }
  const layers = ts.isCallExpression(exportedExpression)
    ? exportedExpression.arguments
    : [exportedExpression];
  const root = new Map<string, ts.Expression>();
  for (const layer of layers) {
    const binding = unwrapConfigExpression(layer);
    if (ts.isIdentifier(binding) && writesConfigBinding(ast, binding.text)) {
      return { type: "unresolved", field: "reassigned configuration layer" };
    }
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
        (imported.moduleSpecifier.text.startsWith(".") ||
          imported.moduleSpecifier.text.startsWith("@stll/"))
      ) {
        const importedFile = importedConfigFile(
          imported.moduleSpecifier.text,
          configFile,
        );
        if (importedFile !== undefined) {
          const importedFields = playwrightConfigFields({
            configFile: importedFile,
            source: readConfig(path.join(ROOT, importedFile)),
            readConfig,
            visited: new Set([...visitedConfigs, configFile]),
          });
          if (importedFields.type === "unresolved") {
            return importedFields;
          }
          fields = importedFields.fields;
        }
      }
    }
    if (fields === undefined) {
      return { type: "unresolved", field: "configuration object" };
    }
    for (const [name, value] of fields) {
      root.set(name, value);
    }
  }
  return { type: "resolved", fields: root };
};

const playwrightConfigCollection = (
  options: PlaywrightConfigOptions,
): PlaywrightCollection => {
  const { file, configFile, projects: selectedProjects } = options;
  const configuration = playwrightConfigFields(options);
  const unresolved = (field: string): PlaywrightCollection => ({
    type: "unresolved",
    finding: `runner config: ${configFile} has unresolved ${field}`,
  });
  if (configuration.type === "unresolved") {
    return unresolved(configuration.field);
  }
  const root = configuration.fields;
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
      return value.test(path.join(ROOT, file));
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
    const bodies: {
      readonly workingDirectory: string;
      readonly arguments_: readonly string[];
    }[] = [];
    gatingArguments({
      command,
      workingDirectory: packageDirectory,
      propagation: PACKAGE_SCRIPT_PROPAGATION,
      onDirectory: (workingDirectory, arguments_) => {
        bodies.push({ workingDirectory, arguments_ });
      },
      invocationEnd: ({ words, index }) =>
        words[index] === "playwright" && words[index + 1] === "test"
          ? index + 2
          : undefined,
    });
    for (const commands of topology.gatingJobs.values()) {
      const invocations = commands.flatMap(
        ({ command: workflowCommand, propagation, workingDirectory = "." }) =>
          gatingArguments({
            command: workflowCommand,
            workingDirectory,
            propagation,
            invocationEnd: ({ words, tokens, index }) =>
              packageInvocationEnd({
                words,
                tokens,
                index,
                packageDirectory,
                packageName,
                scriptName,
                workingDirectory,
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
            [...body.arguments_, ...arguments_],
            `${command} (workflow: ${workflowCommand})`,
          ),
        );
        for (const cli of selections) {
          if (cli.type === "unresolved") {
            const configFile = path.join(
              ROOT,
              body.workingDirectory,
              cli.configName,
            );
            if (
              existsSync(configFile) &&
              playwrightConfigCollection({
                file,
                configFile: path.posix.join(
                  body.workingDirectory,
                  cli.configName,
                ),
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
          const configFile = path.join(
            ROOT,
            body.workingDirectory,
            cli.configName,
          );
          if (!existsSync(configFile)) {
            finding = {
              type: "unresolved",
              finding: `runner config: ${configFile} is missing`,
            };
            continue;
          }
          const collection = playwrightConfigCollection({
            file,
            configFile: path.posix.join(body.workingDirectory, cli.configName),
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
  readonly scenarios: ReadonlyMap<string, TestScenario>;
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

type ExecutedScenarioOptions = {
  readonly file: string;
  readonly scenario: Extract<TestScenario, { type: "executed" }>;
  readonly topology: RepositoryTestExecutionTopology;
};

const executedScenarioFailure = ({
  file,
  scenario,
  topology,
}: ExecutedScenarioOptions): string | undefined => {
  if (scenario.collector.workflow !== ".github/workflows/ci.yml") {
    return `ledger collector: unsupported gating workflow ${scenario.collector.workflow}`;
  }
  const commands = topology.gatingJobs.get(scenario.collector.job);
  if (commands === undefined) {
    return `ledger collector: ${scenario.collector.job} does not reach ci-result`;
  }
  const runner = shellWords(scenario.collector.command);
  const collectedCommands: GatingCommand[] = [];
  for (const {
    command,
    propagation,
    environment,
    workingDirectory = ".",
  } of commands) {
    gatingArguments({
      command,
      workingDirectory,
      propagation,
      invocationEnd: ({ words, index }) =>
        runner.every((word, offset) => words[index + offset] === word)
          ? index
          : undefined,
      onDirectory: (directory, words) => {
        collectedCommands.push({
          command: words.map((word) => JSON.stringify(word)).join(" "),
          workingDirectory: directory,
          propagation,
          environment,
        });
      },
    });
  }
  if (collectedCommands.length === 0) {
    return `ledger collector: no gating invocation of ${scenario.collector.command} in ${scenario.collector.job}`;
  }
  const gatingJobs = new Map([[scenario.collector.job, collectedCommands]]);
  return firstCollectionFailure({
    file,
    scenarios: new Map(),
    topology: { ...topology, gatingJobs },
  });
};

type PinnedScenarioOptions = {
  readonly file: string;
  readonly scenario: Extract<TestScenario, { type: "pinned-collector" }>;
  readonly topology: RepositoryTestExecutionTopology;
};

const pinnedScenarioFailure = ({
  file,
  scenario,
  topology,
}: PinnedScenarioOptions): string | undefined => {
  const { workflow, job: jobId, step: stepName } = scenario.collector;
  if (workflow !== ".github/workflows/ci.yml") {
    return `pinned collector: unsupported gating workflow ${workflow}`;
  }
  if (!topology.gatingJobs.has(jobId)) {
    return `pinned collector: ${jobId} does not reach ci-result`;
  }
  const root = workflowRecord(Bun.YAML.parse(topology.workflow));
  const job = workflowRecord(workflowRecord(root?.["jobs"])?.[jobId]);
  if (job === undefined || !Array.isArray(job["steps"])) {
    return `pinned collector: ${jobId} has no steps`;
  }
  const matches = flattenWorkflowSteps(job["steps"]).filter(
    (step) => step["name"] === stepName,
  );
  const step = matches.at(0);
  if (
    matches.length !== 1 ||
    step === undefined ||
    typeof step["run"] !== "string"
  ) {
    return `pinned collector: missing or ambiguous step ${stepName}`;
  }
  if (
    step["continue-on-error"] !== undefined &&
    step["continue-on-error"] !== false
  ) {
    return `pinned collector: ${stepName} ignores failure`;
  }
  if ((step["if"] ?? "") !== scenario.collector.condition) {
    return `pinned collector: ${stepName} condition differs from the recorded literal`;
  }
  if (effectiveWorkingDirectory({ root, job, step }) !== ".") {
    return `pinned collector: ${stepName} does not use the pinned repository working-directory`;
  }
  const shards = new Set(matrixLegs(job).map((leg) => leg["shard"]));
  if (
    hasDynamicMatrix(job) ||
    allE2eShards().some((shard) => !shards.has(shard))
  ) {
    return `pinned collector: ${jobId} does not declare the complete literal shard partition`;
  }
  const condition = step["if"];
  if (
    condition !== undefined &&
    condition !== true &&
    !(
      typeof condition === "string" &&
      ["always()", "success()", "true"].includes(conditionExpression(condition))
    )
  ) {
    return `pinned collector: ${stepName} has a conditional execution path`;
  }
  const shell = effectiveWorkflowShell({
    root,
    job,
    step,
    legs: matrixLegs(job),
  });
  if (
    shell.type !== "supported" ||
    !shell.propagation.errexit ||
    !shell.propagation.pipefail
  ) {
    return `pinned collector: ${stepName} does not use the pinned Bash execution settings`;
  }
  if (
    e2eProductionPlanFingerprint(step["run"]) !==
    configuredBudgets.e2eProductionShards.planSha256
  ) {
    return `pinned collector: ${stepName} plan fingerprint mismatch`;
  }
  const configFile = "apps/web/e2e/playwright.config.ts";
  if (!configuredBudgets.e2eProductionShards.planFiles.includes(configFile)) {
    return `pinned collector: plan does not pin its runner configuration`;
  }
  const collection = playwrightConfigCollection({
    file,
    configFile,
    source: readFileSync(path.join(ROOT, configFile), "utf-8"),
    readConfig: (configPath) => readFileSync(configPath, "utf-8"),
    projects: [],
  });
  return collection.type === "collected"
    ? undefined
    : `pinned collector: ${collection.type === "unresolved" ? collection.finding : `${file} is outside the pinned runner config`}`;
};

export const scenarioBlockerFailure = (
  blocker: ScenarioBlocker,
  readProducer = (file: string): string | undefined =>
    existsSync(path.join(ROOT, file))
      ? readFileSync(path.join(ROOT, file), "utf-8")
      : undefined,
): string | undefined => {
  switch (blocker.blocker) {
    case "stack-status-gate": {
      if (blocker.producer !== "setup-e2e-stack status") {
        return "scenario blocker: unknown stack status producer";
      }
      const source = readProducer(".github/actions/setup-e2e-stack/action.yml");
      if (source === undefined) {
        return "scenario blocker: stack status producer is missing";
      }
      const action = workflowRecord(Bun.YAML.parse(source));
      const outputs = workflowRecord(action?.["outputs"]);
      if (!isRecord(outputs?.["status"])) {
        return "scenario blocker: stack status output is missing";
      }
      return sha256Hex(source) === blocker.producerSha256
        ? undefined
        : "scenario blocker: stack status producer changed; remove or revalidate the entry";
    }
    case "unproven-selection-producer": {
      const match =
        /^(?<workflow>.+\.ya?ml)\/(?<job>[^/]+)\/(?<step>[\w-]+)\.outputs\.(?<output>[\w-]+)$/u.exec(
          blocker.producer,
        )?.groups;
      if (
        match === undefined ||
        match["workflow"] !== ".github/workflows/ci.yml"
      ) {
        return "scenario blocker: selection producer reference is invalid";
      }
      const jobName = match["job"];
      const stepId = match["step"];
      const output = match["output"];
      const source = readProducer(match["workflow"]);
      if (
        source === undefined ||
        jobName === undefined ||
        stepId === undefined ||
        output === undefined
      ) {
        return "scenario blocker: selection producer is missing";
      }
      const workflow: unknown = Bun.YAML.parse(source);
      const job = workflowRecord(
        workflowRecord(workflowRecord(workflow)?.["jobs"])?.[jobName],
      );
      const steps = Array.isArray(job?.["steps"])
        ? flattenWorkflowSteps(job["steps"])
        : [];
      const matches = steps.filter((step) => step["id"] === stepId);
      const step = matches.at(0);
      if (
        matches.length !== 1 ||
        step === undefined ||
        typeof step["run"] !== "string"
      ) {
        return "scenario blocker: selection producer step is missing or duplicated";
      }
      if (!declaredSelectionOutputs(step["run"], [output]).has(output)) {
        return "scenario blocker: selection output is missing or renamed";
      }
      if (sha256Hex(JSON.stringify(step)) !== blocker.producerSha256) {
        return "scenario blocker: selection producer changed; remove or revalidate the entry";
      }
      const registered = validateTrustedOutputProducers({
        workflow,
        registry: TRUSTED_OUTPUT_PRODUCERS,
        scope: "present-jobs",
      });
      if (
        registered.references
          .get(jobName)
          ?.has(`steps.${stepId}.outputs.${output}`)
      ) {
        return "scenario blocker: selection producer now has proof; remove the entry";
      }
      return undefined;
    }
    default:
      return panic(
        `Unrecognized scenario blocker: ${String(blocker.blocker satisfies never)}`,
      );
  }
};

type PlatformConditionalFailureOptions = {
  readonly entry: PlatformConditionalEntry;
  readonly file: string;
  readonly source: string;
  readonly topology: RepositoryTestExecutionTopology;
};

export const platformConditionalFailure = ({
  entry,
  file,
  source,
  topology,
}: PlatformConditionalFailureOptions): string | undefined => {
  const matching = parseTestRegistrations(file, source).filter(
    (finding) => finding.identity === entry.identity,
  );
  const finding = matching.at(0);
  if (
    matching.length !== 1 ||
    finding?.type !== "disabled" ||
    finding.skippedOn?.at(0) !== "win32"
  ) {
    return "platform conditional: skipIf must use literal process.platform === win32";
  }
  const root = workflowRecord(Bun.YAML.parse(topology.workflow));
  const jobs = workflowRecord(root?.["jobs"]) ?? {};
  const gatingJobs = new Map(
    [...topology.gatingJobs].filter(([name]) => {
      const runner = workflowRecord(jobs[name])?.["runs-on"];
      return (
        typeof runner === "string" &&
        /^(?:ubuntu|linux|macos)(?:-|$)/u.test(runner)
      );
    }),
  );
  const collection = firstCollectionFailure({
    file,
    scenarios: new Map(),
    topology: { ...topology, gatingJobs },
  });
  return collection === undefined
    ? undefined
    : `platform conditional: no proven non-win32 gating collector; ${collection}`;
};

type ScenarioCollectionFailureOptions = {
  readonly file: string;
  readonly scenario: TestScenario;
  readonly topology: RepositoryTestExecutionTopology;
};

const scenarioCollectionFailure = ({
  file,
  scenario,
  topology,
}: ScenarioCollectionFailureOptions) => {
  switch (scenario.type) {
    case "non-gating":
      return typeof scenario.reason === "string"
        ? undefined
        : scenarioBlockerFailure(scenario.reason);
    case "executed":
      return executedScenarioFailure({ file, scenario, topology });
    case "pinned-collector":
      return pinnedScenarioFailure({ file, scenario, topology });
    default:
      return panic(
        `Unrecognized scenario: ${String(scenario satisfies never)}`,
      );
  }
};

type DirectWorkflowCollectionOptions = {
  readonly file: string;
  readonly topology: RepositoryTestExecutionTopology;
};

const directWorkflowCollectionFailure = ({
  file,
  topology,
}: DirectWorkflowCollectionOptions): string | undefined => {
  const isRepositoryScript =
    file.startsWith("scripts/") || file.startsWith(".oxlint-plugins/");
  const isUnlistedScript =
    isRepositoryScript &&
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
        const workingDirectory = invocationWorkingDirectory({
          words,
          tokens,
          index,
          workingDirectory: gatingCommand.workingDirectory ?? ".",
          propagation,
        });
        if (workingDirectory === undefined) {
          conditions.push(
            "runner working-directory: unresolved directory change",
          );
          return false;
        }
        const nested = nestedShellInvocation({ words, tokens, index });
        if (nested.type === "unsupported") {
          conditions.push(nested.reason);
          return false;
        }
        if (nested.type === "supported") {
          return commandMatches({
            command: nested.body,
            workingDirectory,
            propagation: nested.propagation,
            environment: gatingCommand.environment,
          });
        }
        if (
          isUnlistedScript &&
          workingDirectory === "." &&
          words[index] === "bun" &&
          words[index + 1] === "scripts/run-unlisted-script-tests.ts"
        ) {
          return true;
        }
        if (words[index] !== "bun") {
          return false;
        }
        const { words: invocation } = shellCommandSpan(tokens, index);
        if (
          workingDirectory === "." &&
          words[index + 1] === "scripts/run-custom-lint-tests.ts"
        ) {
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
            packageDirectory: workingDirectory,
            scripts: { test: line },
          }) === undefined
        ) {
          return true;
        }
        const cwdIndex = invocation.indexOf("--cwd");
        let packageDirectory = workingDirectory;
        let scriptIndex = invocation[1] === "run" ? 2 : 1;
        if (cwdIndex !== -1) {
          if (cwdIndex !== scriptIndex) {
            return false;
          }
          const resolved = literalDirectory(
            invocation[cwdIndex + 1],
            workingDirectory,
          );
          if (resolved === undefined) {
            conditions.push("runner working-directory: unresolved Bun --cwd");
            return false;
          }
          packageDirectory = resolved;
          scriptIndex = cwdIndex + 2;
        } else if (invocation[1] !== "run") {
          return false;
        }
        const scriptName = invocation[scriptIndex];
        if (scriptName === undefined) {
          return false;
        }
        const manifest = path.posix.join(packageDirectory, "package.json");
        if (!existsSync(path.join(ROOT, manifest))) {
          return false;
        }
        const scripts = packageScripts(manifest);
        const testCommand = scripts?.[scriptName];
        if (typeof testCommand !== "string") {
          return false;
        }
        const arguments_ = invocation
          .slice(scriptIndex + 1)
          .map((word) => JSON.stringify(word))
          .join(" ");
        return (
          packageTestCollectionFailure({
            candidate: file,
            packageDirectory,
            scriptName,
            scripts: {
              ...scripts,
              [scriptName]: `${testCommand} ${arguments_}`,
            },
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
};

export const firstCollectionFailure = ({
  file,
  scenarios,
  topology = repositoryTestExecutionTopology(),
}: FirstCollectionOptions): string | undefined => {
  const scenario = scenarios.get(file);
  if (scenario !== undefined) {
    return scenarioCollectionFailure({ file, scenario, topology });
  }
  const directFailure = directWorkflowCollectionFailure({ file, topology });
  if (
    file.startsWith("scripts/") ||
    file.startsWith(".oxlint-plugins/") ||
    directFailure === undefined
  ) {
    return directFailure;
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
  errors.push(
    ...validateTrustedOutputProducers({
      workflow: Bun.YAML.parse(workflow),
      registry: TRUSTED_OUTPUT_PRODUCERS,
    }).findings,
  );
  const analysis = analyzeGatingWorkflow(Bun.YAML.parse(workflow));
  const gatingJobs = analysis.jobs;
  errors.push(
    ...analysis.findings.filter((finding) =>
      finding.startsWith("trusted output producer:"),
    ),
  );
  // Unsupported steps collect nothing; another gating job may own their files.
  if (analysis.findings.length > 0) {
    console.log(analysis.findings.join("\n"));
  }
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
  for (const file of scenarioLedgerGrowth(
    scenarioLedgerBaseline(),
    nonGating,
  )) {
    errors.push(`scenario ledger is shrink-only: added ${file}`);
  }
  const scenarios = new Map(
    nonGating.map((scenario) => [scenario.file, scenario]),
  );
  if (scenarios.size !== nonGating.length) {
    errors.push("scenario ledger contains duplicate files");
  }
  for (const scenario of nonGating) {
    if (!files.includes(scenario.file)) {
      errors.push(`non-gating file is not tracked: ${scenario.file}`);
    }
  }
  for (const file of files) {
    const brokenEdge = firstCollectionFailure({ file, scenarios });
    if (brokenEdge !== undefined) {
      errors.push(`${file}: ${brokenEdge}`);
    }
  }

  for (const entry of disabledLedger.platformConditionals) {
    const file = entry.identity.split("::").at(0);
    if (file === undefined || !files.includes(file)) {
      errors.push(`${entry.identity}: platform conditional file is missing`);
      continue;
    }
    const failure = platformConditionalFailure({
      entry,
      file,
      source: readFileSync(path.join(ROOT, file), "utf-8"),
      topology: repositoryTestExecutionTopology(),
    });
    if (failure !== undefined) {
      errors.push(`${entry.identity}: ${failure}`);
    }
  }
  const managedGates = new Set(disabledLedger.managedServiceGates);
  const actualDisabled: string[] = [];
  for (const file of files) {
    const source = readFileSync(path.join(ROOT, file), "utf-8");
    for (const finding of parseTestRegistrations(file, source)) {
      switch (finding.type) {
        case "only":
          errors.push(`${finding.identity}: .only is forbidden`);
          break;
        case "unresolved":
          errors.push(`${finding.identity}: ${finding.reason}`);
          break;
        case "disabled":
          if (
            finding.managedServiceGate === undefined ||
            !managedGates.has(finding.managedServiceGate)
          ) {
            actualDisabled.push(finding.identity);
          }
          break;
        default:
          panic(`Unrecognized finding: ${String(finding satisfies never)}`);
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
    `Checked ${files.length} tracked test files; ${nonGating.filter(({ type }) => type === "non-gating").length} non-gating scenarios receive no execution credit; manifest derived in memory.`,
  );
};

if (import.meta.main) {
  run();
}
