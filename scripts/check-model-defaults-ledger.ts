import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript6";

import {
  AI_PROVIDERS,
  type AIProvider,
} from "../packages/ai-catalog/src/index";
import {
  MODEL_DEFAULTS_LEDGER,
  MODEL_TASKS,
  type ModelDefaultEntry,
  type ModelDefaultQuality,
  type ModelTask,
} from "../packages/ai-catalog/src/model-defaults-ledger";
import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import {
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "./ledger-membership";

const EXCEPTIONS_REL = "scripts/model-defaults-exceptions.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CATALOG_SOURCE = "packages/ai-catalog/src/index.ts";
const REMOVED_MODEL_EXPORTS = new Set([
  "ModelRole",
  "MODEL_ROLES",
  "DEFAULT_MODELS",
  "generateTanStackTextForRole",
  "generateTanStackObjectForRole",
  "streamTanStackTextForRole",
  "streamTanStackObjectForRole",
  "getTanStackTextModelForRole",
  "getTanStackTextModelInfoForRole",
  "requireTanStackAIAvailableForRole",
  "isAllowedBYOKModelForRole",
  "isDeferredServiceTierAvailableForRole",
  "resolveOrgAIModelForRole",
  "resolveWorkingBYOKModelForRole",
  "getTemperatureForRole",
  "tanStackModelOptionsForRole",
]);
export const LEGACY_FIELD_BY_MODEL_CALL = {
  generateTanStackTextForTask: "role",
  generateTanStackObjectForTask: "role",
  streamTanStackTextForTask: "role",
  streamTanStackObjectForTask: "role",
  getTanStackTextModelById: "role",
  getTanStackTextModelForTask: "role",
  getTanStackTextModelInfoForTask: "role",
  requireTanStackAIAvailableForTask: "role",
  isAllowedBYOKModelForTask: "role",
  isDeferredServiceTierAvailableForTask: "role",
  resolveWorkingBYOKModelForTask: "role",
  resolveOrgAIModelForTask: "role",
  resolveTanStackTextModel: "role",
  tanStackModelOptionsForTask: "role",
  resolveCaching: "role",
  createTanStackAIAnalyticsCallbacks: "modelRole",
  recordUsageEvent: "modelRole",
} as const satisfies Record<string, "role" | "modelRole">;
const MEASURED_DEFAULT_ELIGIBILITY = {
  "local-eval": "eligible",
  "same-weights": "eligible",
  "external-benchmark": "ineligible",
} as const satisfies Record<
  Exclude<ModelDefaultQuality["source"], "seed">,
  "eligible" | "ineligible"
>;

type CheckModelDefaultsLedgerOptions = {
  ledger: Readonly<
    Record<ModelTask, Readonly<Record<AIProvider, ModelDefaultEntry>>>
  >;
  exceptions: readonly string[];
};

export const checkModelDefaultsLedger = ({
  ledger,
  exceptions,
}: CheckModelDefaultsLedgerOptions): string[] => {
  const errors: string[] = [];
  const requiredExceptions = new Set<string>();
  for (const task of MODEL_TASKS) {
    for (const provider of AI_PROVIDERS) {
      const entry = ledger[task][provider];
      if (entry.kind === "unsupported") {
        if (task !== "pdf" || provider !== "mistral") {
          errors.push(
            `${task}/${provider}: unsupported defaults require an existing document-input exception`,
          );
        }
        requiredExceptions.add(`unsupported:${task}:${provider}`);
        continue;
      }
      const { quality, candidate } = entry;
      if (quality.measurement.status !== "unmeasured") {
        if (quality.measurement.modelId !== candidate.modelId) {
          errors.push(
            `${task}/${provider}: measured evidence must match the selected model`,
          );
        }
        if (quality.measurement.provider !== provider) {
          errors.push(
            `${task}/${provider}: measured evidence must match the selected provider`,
          );
        }
      }
      if (quality.source === "seed") {
        requiredExceptions.add(`seed:${task}:${provider}`);
        if (
          quality.measurement.status === "different-mode" &&
          isDeepStrictEqual(candidate.mode, quality.measurement.measuredMode)
        ) {
          errors.push(
            `${task}/${provider}: different-mode evidence matches the selected mode`,
          );
        }
        continue;
      }
      if (MEASURED_DEFAULT_ELIGIBILITY[quality.source] === "ineligible") {
        errors.push(
          `${task}/${provider}: external benchmarks cannot qualify a measured default`,
        );
      }
      if (
        !isDeepStrictEqual(candidate.mode, quality.measurement.measuredMode)
      ) {
        errors.push(
          `${task}/${provider}: measured evidence must match the selected mode`,
        );
      }
    }
  }
  const allowed = new Set(exceptions);
  if (allowed.size !== exceptions.length) {
    errors.push("model default exceptions must be duplicate-free");
  }
  for (const id of requiredExceptions) {
    if (!allowed.has(id)) {
      errors.push(`${id}: missing model default exception`);
    }
  }
  for (const id of allowed) {
    if (!requiredExceptions.has(id)) {
      errors.push(`${id}: stale model default exception`);
    }
  }
  return errors;
};

type CheckModelDefaultsSourceOptions = {
  relativePath: string;
  source: string;
};

export const checkModelDefaultsSource = ({
  relativePath,
  source,
}: CheckModelDefaultsSourceOptions): string[] => {
  const errors: string[] = [];
  const file = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const reportRemoved = (name: string) => {
    if (REMOVED_MODEL_EXPORTS.has(name)) {
      errors.push(
        `${relativePath}: ${name} is replaced by the task ledger contract`,
      );
    }
  };
  const modelCalls = new Map(Object.entries(LEGACY_FIELD_BY_MODEL_CALL));
  const registerImport = (binding: ts.ImportSpecifier) => {
    const name = (binding.propertyName ?? binding.name).text;
    reportRemoved(name);
    if (binding.propertyName !== undefined) {
      reportRemoved(binding.name.text);
    }
    const legacyField = modelCalls.get(name);
    if (legacyField !== undefined) {
      modelCalls.set(binding.name.text, legacyField);
    }
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          registerImport(binding);
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const binding of clause.elements) {
          reportRemoved(binding.name.text);
          if (binding.propertyName !== undefined) {
            reportRemoved(binding.propertyName.text);
          }
        }
      }
      continue;
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          continue;
        }
        if (exported || relativePath.startsWith("packages/ai-catalog/src/")) {
          reportRemoved(declaration.name.text);
        }
        if (
          relativePath === CATALOG_SOURCE &&
          declaration.name.text === "BYOK_DEFAULT_MODELS" &&
          declaration.initializer !== undefined
        ) {
          const inspectPresentation = (node: ts.Node) => {
            if (
              ts.isPropertyAssignment(node) ||
              ts.isShorthandPropertyAssignment(node)
            ) {
              const name = ts.isComputedPropertyName(node.name)
                ? node.name.expression
                : node.name;
              if (
                (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
                name.text === "modelId"
              ) {
                errors.push(
                  `${relativePath}: BYOK default model IDs must be projected from the task ledger`,
                );
              }
            }
            ts.forEachChild(node, inspectPresentation);
          };
          inspectPresentation(declaration.initializer);
        }
      }
      continue;
    }
    if (
      (exported || relativePath.startsWith("packages/ai-catalog/src/")) &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      reportRemoved(statement.name.text);
    }
  }
  const inspectModelCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      const legacyField = ts.isIdentifier(name)
        ? modelCalls.get(name.text)
        : undefined;
      if (legacyField !== undefined) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) {
            continue;
          }
          for (const property of argument.properties) {
            if (
              !ts.isPropertyAssignment(property) &&
              !ts.isShorthandPropertyAssignment(property)
            ) {
              continue;
            }
            const key = ts.isComputedPropertyName(property.name)
              ? property.name.expression
              : property.name;
            if (
              (ts.isIdentifier(key) || ts.isStringLiteral(key)) &&
              key.text === legacyField
            ) {
              errors.push(
                `${relativePath}: ${name.getText(file)} requires the task contract; remove ${legacyField}`,
              );
            }
          }
        }
      }
    }
    ts.forEachChild(node, inspectModelCalls);
  };
  inspectModelCalls(file);
  return errors;
};

const checkRepositoryModelDefaultsSources = (): string[] => {
  const errors: string[] = [];
  const sources = new Bun.Glob("{apps,packages}/*/src/**/*.{ts,tsx}");
  for (const relativePath of sources.scanSync({
    cwd: REPO_ROOT,
    onlyFiles: true,
  })) {
    if (
      /\.(?:test|gen|type-test)\.tsx?$/u.test(relativePath) ||
      relativePath.includes("/tests/")
    ) {
      continue;
    }
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
    if (
      !source.includes("ForRole") &&
      !source.includes("ModelRole") &&
      !source.includes("MODEL_ROLES") &&
      !source.includes("DEFAULT_MODELS") &&
      !Object.keys(LEGACY_FIELD_BY_MODEL_CALL).some((name) =>
        source.includes(name),
      )
    ) {
      continue;
    }
    errors.push(...checkModelDefaultsSource({ relativePath, source }));
  }
  return errors;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    const result = Bun.spawnSync(
      ["bun", "test", "scripts/check-model-defaults-ledger.test.ts"],
      { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
    );
    process.exit(childExitStatus(result));
  }
  const exceptions = parseReasonedLedger(
    readFileSync(path.join(REPO_ROOT, EXCEPTIONS_REL), "utf-8"),
    EXCEPTIONS_REL,
  );
  const errors = checkModelDefaultsLedger({
    ledger: MODEL_DEFAULTS_LEDGER,
    exceptions,
  });
  errors.push(...checkRepositoryModelDefaultsSources());
  for (const error of errors) {
    console.error(error);
  }
  if (errors.length > 0) {
    process.exit(1);
  }
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: EXCEPTIONS_REL,
      repoRoot: REPO_ROOT,
      parseLedger: parseReasonedLedger,
      label: "model-defaults",
      remediation:
        "supply matching local evaluation or same-weights evidence instead of a new exemption",
      args,
    }),
  );
}
