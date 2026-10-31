import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  type ImportSpecifier,
  isObjectLiteralProperty,
  type ModuleExportName,
  type Node,
  type ObjectProperty,
  type ObjectPropertyKind,
  parseSource,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";
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

const moduleExportName = (name: ModuleExportName) =>
  name.type === "Identifier" ? name.name : name.value;

// `import { a as b }` and `export { a as b }`: an unrenamed specifier spells
// one name, whose two nodes share a span.
const renames = (from: Node, to: Node) => from.start !== to.start;

// A `key: value` or shorthand entry, not a method or accessor.
const isValueEntry = (
  property: ObjectPropertyKind,
): property is ObjectProperty =>
  property.type === "Property" && property.kind === "init" && !property.method;

// A computed key reads its expression the same way as a plain key.
const keyText = (key: Node) => {
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
};

// `export` wraps the declaration it exports.
const unwrapExport = (topLevel: Program["body"][number]) =>
  topLevel.type === "ExportNamedDeclaration" ||
  topLevel.type === "ExportDefaultDeclaration"
    ? { exported: true, statement: topLevel.declaration }
    : { exported: false, statement: topLevel };

type CheckModelDefaultsSourceOptions = {
  relativePath: string;
  source: string;
};

export const checkModelDefaultsSource = ({
  relativePath,
  source,
}: CheckModelDefaultsSourceOptions): string[] => {
  const errors: string[] = [];
  const { program } = parseSource(relativePath, source);
  const reportRemoved = (name: string) => {
    if (REMOVED_MODEL_EXPORTS.has(name)) {
      errors.push(
        `${relativePath}: ${name} is replaced by the task ledger contract`,
      );
    }
  };
  const modelCalls = new Map(Object.entries(LEGACY_FIELD_BY_MODEL_CALL));
  const registerImport = (binding: ImportSpecifier) => {
    const name = moduleExportName(binding.imported);
    reportRemoved(name);
    if (renames(binding.imported, binding.local)) {
      reportRemoved(binding.local.name);
    }
    const legacyField = modelCalls.get(name);
    if (legacyField !== undefined) {
      modelCalls.set(binding.local.name, legacyField);
    }
  };
  for (const topLevel of program.body) {
    if (topLevel.type === "ImportDeclaration") {
      for (const binding of topLevel.specifiers) {
        if (binding.type === "ImportSpecifier") {
          registerImport(binding);
        }
      }
      continue;
    }
    if (
      topLevel.type === "ExportNamedDeclaration" &&
      topLevel.declaration === null
    ) {
      for (const binding of topLevel.specifiers) {
        reportRemoved(moduleExportName(binding.exported));
        if (renames(binding.local, binding.exported)) {
          reportRemoved(moduleExportName(binding.local));
        }
      }
      continue;
    }
    const { exported, statement } = unwrapExport(topLevel);
    if (statement?.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier") {
          continue;
        }
        if (exported || relativePath.startsWith("packages/ai-catalog/src/")) {
          reportRemoved(declaration.id.name);
        }
        if (
          relativePath === CATALOG_SOURCE &&
          declaration.id.name === "BYOK_DEFAULT_MODELS" &&
          declaration.init !== null
        ) {
          walk(declaration.init, (node, ancestors) => {
            if (
              isObjectLiteralProperty(node, ancestors.at(-1)) &&
              isValueEntry(node) &&
              keyText(node.key) === "modelId"
            ) {
              errors.push(
                `${relativePath}: BYOK default model IDs must be projected from the task ledger`,
              );
            }
          });
        }
      }
      continue;
    }
    if (
      (exported || relativePath.startsWith("packages/ai-catalog/src/")) &&
      (statement?.type === "FunctionDeclaration" ||
        statement?.type === "TSDeclareFunction" ||
        statement?.type === "TSTypeAliasDeclaration" ||
        statement?.type === "TSInterfaceDeclaration") &&
      statement.id !== null
    ) {
      reportRemoved(statement.id.name);
    }
  }
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const name =
      node.callee.type === "MemberExpression" && !node.callee.computed
        ? node.callee.property
        : node.callee;
    const legacyField =
      name.type === "Identifier" ? modelCalls.get(name.name) : undefined;
    if (legacyField === undefined) {
      return;
    }
    for (const argument of node.arguments) {
      if (argument.type !== "ObjectExpression") {
        continue;
      }
      for (const property of argument.properties) {
        if (isValueEntry(property) && keyText(property.key) === legacyField) {
          errors.push(
            `${relativePath}: ${source.slice(name.start, name.end)} requires the task contract; remove ${legacyField}`,
          );
        }
      }
    }
  });
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
