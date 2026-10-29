import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import {
  MODEL_OPERATION_BOUNDARIES,
  MODEL_OPERATION_NAMES,
} from "../apps/api/src/lib/model-operation-registry.ts";
import MODEL_OPERATIONS from "./ownership/model-operation-callers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const LEDGER = "scripts/generated-artefact-provenance-transition.json";
const MODEL_MODULES = new Set([
  "apps/api/src/lib/tanstack-ai-generate",
  "apps/api/src/lib/chat/tanstack-chat-runtime",
]);
const PROVENANCE_MODULE = "apps/api/src/lib/generated-artefact-provenance";
const names = new Set<string>(MODEL_OPERATION_NAMES);
const registered = new Set<string>(MODEL_OPERATIONS.owner);
const implementations = new Set(
  [...MODEL_MODULES, PROVENANCE_MODULE].map((name) => `${name}.ts`),
);

const modulePath = (file: string, specifier: string) =>
  (specifier.startsWith("@/api/")
    ? specifier.replace("@/api/", "apps/api/src/")
    : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
  ).replace(/\.(?:ts|js)$/u, "");

type ScanOptions = { file: string; source: string };
/** Count calls, including aliases/injected defaults, rather than grandfathering a file. */
const bindingContains = (binding: ts.BindingName, name: string): boolean => {
  if (ts.isIdentifier(binding)) {
    return binding.text === name;
  }
  return binding.elements.some(
    (element) =>
      ts.isBindingElement(element) && bindingContains(element.name, name),
  );
};
const shadowed = (node: ts.Node, name: string) => {
  for (let scope = node.parent; !ts.isSourceFile(scope); scope = scope.parent) {
    if (
      (ts.isArrowFunction(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isFunctionDeclaration(scope) ||
        ts.isMethodDeclaration(scope)) &&
      scope.parameters.some((parameter) =>
        bindingContains(parameter.name, name),
      )
    ) {
      return true;
    }
    if (ts.isFunctionExpression(scope) && scope.name?.text === name) {
      return true;
    }
    if (
      ts.isBlock(scope) &&
      scope.statements.some(
        (statement) =>
          (ts.isFunctionDeclaration(statement) &&
            statement.name?.text === name) ||
          (ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some((declaration) =>
              bindingContains(declaration.name, name),
            )),
      )
    ) {
      return true;
    }
  }
  return false;
};
type WrappedOptions = {
  node: ts.Node;
  wrappers: ReadonlySet<string>;
  wrapperNamespaces: ReadonlySet<string>;
};
const wrapped = ({ node, wrappers, wrapperNamespaces }: WrappedOptions) => {
  for (
    let callback = node.parent;
    !ts.isSourceFile(callback);
    callback = callback.parent
  ) {
    let property: ts.ObjectLiteralElementLike;
    if (ts.isMethodDeclaration(callback)) {
      property = callback;
    } else if (
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
      ts.isPropertyAssignment(callback.parent)
    ) {
      property = callback.parent;
    } else {
      continue;
    }
    if (
      !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
      property.name.text !== "generate" ||
      !ts.isObjectLiteralExpression(property.parent)
    ) {
      continue;
    }
    const call = property.parent.parent;
    if (
      !ts.isCallExpression(call) ||
      !call.arguments.includes(property.parent)
    ) {
      continue;
    }
    const callee = call.expression;
    if (
      ts.isIdentifier(callee) &&
      wrappers.has(callee.text) &&
      !shadowed(call, callee.text)
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      wrapperNamespaces.has(callee.expression.text) &&
      callee.name.text === "generateArtefact" &&
      !shadowed(call, callee.expression.text)
    ) {
      return true;
    }
  }
  return false;
};

type ModelBindings = {
  bindings: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
};
const modelReference = ({ bindings, namespaces }: ModelBindings) => {
  const reference = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      return bindings.has(expression.text);
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return reference(expression.expression);
    }
    if (ts.isConditionalExpression(expression)) {
      return reference(expression.whenTrue) || reference(expression.whenFalse);
    }
    if (ts.isBinaryExpression(expression)) {
      return reference(expression.left) || reference(expression.right);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return (
        bindings.has(expression.name.text) ||
        (ts.isIdentifier(expression.expression) &&
          namespaces.has(expression.expression.text) &&
          names.has(expression.name.text))
      );
    }
    if (
      ts.isElementAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      namespaces.has(expression.expression.text)
    ) {
      return (
        !ts.isStringLiteral(expression.argumentExpression) ||
        names.has(expression.argumentExpression.text)
      );
    }
    return false;
  };
  return reference;
};

export const inspectArtefactGenerators = ({ file, source }: ScanOptions) => {
  // Escaped strings still take the AST path; unrelated modules need no parse.
  if (
    !["tanstack", "generationProvenance", "generated-artefact", "\\"].some(
      (token) => source.includes(token),
    )
  ) {
    return { modelImport: false, legacyCalls: 0, writes: [] };
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  const namespaces = new Set<string>();
  const wrappers = new Set<string>();
  const wrapperNamespaces = new Set<string>();
  let modelImport = false;
  const visit = (node: ts.Node, action: (node: ts.Node) => void) => {
    action(node);
    ts.forEachChild(node, (child) => visit(child, action));
  };
  visit(tree, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    ) {
      return;
    }
    if (node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
      return;
    }
    const module = modulePath(file, node.moduleSpecifier.text);
    const imported = node.importClause?.namedBindings;
    if (imported === undefined) {
      return;
    }
    const model = MODEL_MODULES.has(module);
    const provenance = module === PROVENANCE_MODULE;
    if (ts.isNamespaceImport(imported)) {
      if (model) {
        namespaces.add(imported.name.text);
        modelImport = true;
      }
      if (provenance) {
        wrapperNamespaces.add(imported.name.text);
      }
      return;
    }
    for (const item of imported.elements) {
      if (item.isTypeOnly) {
        continue;
      }
      const name = item.propertyName?.text ?? item.name.text;
      if (model && names.has(name)) {
        bindings.add(item.name.text);
        modelImport = true;
      }
      if (provenance && name === "generateArtefact") {
        wrappers.add(item.name.text);
        modelImport = true;
      }
    }
  });
  const reference = modelReference({ bindings, namespaces });
  // Resolve aliases to a fixed point, including a chain declared before its source.
  let changed = true;
  const resolveAlias = (node: ts.Node) => {
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isVariableDeclaration(node.parent.parent) &&
      node.parent.parent.initializer !== undefined &&
      ts.isIdentifier(node.parent.parent.initializer) &&
      namespaces.has(node.parent.parent.initializer.text)
    ) {
      const property = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
        names.has(property.text) &&
        !bindings.has(node.name.text)
      ) {
        bindings.add(node.name.text);
        changed = true;
      }
    }
    if (
      !(
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)
      ) ||
      !ts.isIdentifier(node.name) ||
      node.initializer === undefined ||
      !reference(node.initializer)
    ) {
      return;
    }
    if (!bindings.has(node.name.text)) {
      bindings.add(node.name.text);
      changed = true;
    }
  };
  while (changed) {
    changed = false;
    visit(tree, resolveAlias);
  }
  let legacyCalls = 0;
  const writes: number[] = [];
  visit(tree, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments.at(0);
      if (
        specifier !== undefined &&
        ts.isStringLiteral(specifier) &&
        MODEL_MODULES.has(modulePath(file, specifier.text))
      ) {
        modelImport = true;
        if (!wrapped({ node, wrappers, wrapperNamespaces })) {
          legacyCalls++;
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      reference(node.expression) &&
      !wrapped({ node, wrappers, wrapperNamespaces })
    ) {
      legacyCalls++;
    }
    if (!ts.isPropertyAssignment(node)) {
      return;
    }
    let key = "";
    if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
      key = node.name.text;
    } else if (
      ts.isComputedPropertyName(node.name) &&
      ts.isStringLiteral(node.name.expression)
    ) {
      key = node.name.expression.text;
    }
    if (key !== "generationProvenance") {
      return;
    }
    for (
      let parent = node.parent;
      !ts.isSourceFile(parent);
      parent = parent.parent
    ) {
      if (
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        ["set", "values", "onConflictDoUpdate"].includes(
          parent.expression.name.text,
        )
      ) {
        writes.push(
          tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        );
        break;
      }
    }
  });
  return { modelImport, legacyCalls, writes };
};

/** Generation dispatch exports follow the existing collect/generate/stream API. */
export const exportedModelOperations = ({
  file,
  source,
}: ScanOptions): string[] => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  for (const statement of tree.statements) {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      result.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          result.push(declaration.name.text);
        }
      }
    }
  }
  return result
    .filter((name) => /^(?:collect|generate|stream)/u.test(name))
    .toSorted();
};

type Ledger = Record<string, number>;
type AssessOptions = {
  file: string;
  scanned: ReturnType<typeof inspectArtefactGenerators>;
  ledger: Ledger;
};
export const assessArtefactGenerator = ({
  file,
  scanned,
  ledger,
}: AssessOptions): string[] => {
  const errors: string[] = [];
  if (scanned.modelImport && !registered.has(file)) {
    errors.push(`${file}: unregistered model generator`);
  }
  if (scanned.legacyCalls !== (ledger[file] ?? 0)) {
    errors.push(
      `${file}: raw generation count ${scanned.legacyCalls}; migrate through generateArtefact and shrink the transition list`,
    );
  }
  for (const line of scanned.writes) {
    errors.push(
      `${file}:${line}: provenance writes belong to the artefact owner`,
    );
  }
  return errors;
};
const parseLedger = (text: string): Ledger => {
  const input: unknown = JSON.parse(text);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return panic("Invalid provenance transition list");
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0
      ) {
        return panic("Invalid provenance transition count");
      }
      return [key, value] as const;
    }),
  );
};
const baseSources = (
  root: string,
  revision: string,
  files: readonly string[],
) => {
  const result = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd: root,
    stdin: Buffer.from(files.map((file) => `${revision}:${file}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return panic("Cannot read provenance transition base blobs");
  }
  const sources = new Map<string, string>();
  let offset = 0;
  for (const file of files) {
    const lineEnd = result.stdout.indexOf(10, offset);
    if (lineEnd < offset) {
      return panic("Incomplete provenance transition blob header");
    }
    const header = result.stdout.subarray(offset, lineEnd).toString();
    offset = lineEnd + 1;
    if (header === `${revision}:${file} missing`) {
      continue;
    }
    const match = /^[a-f0-9]+ blob ([0-9]+)$/u.exec(header);
    const sizeText = match?.at(1);
    if (sizeText === undefined) {
      return panic("Unexpected provenance transition blob response");
    }
    const size = Number(sizeText);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      result.stdout[offset + size] !== 10
    ) {
      return panic("Invalid provenance transition blob length");
    }
    sources.set(file, result.stdout.subarray(offset, offset + size).toString());
    offset += size + 1;
  }
  return sources;
};
type CheckOptions = { root?: string; base?: string };
export const checkArtefactProvenance = ({
  root = ROOT,
  base = "origin/main",
}: CheckOptions = {}) => {
  const ledger = parseLedger(readFileSync(path.join(root, LEDGER), "utf-8"));
  const baseResult = Bun.spawnSync(["git", "merge-base", "HEAD", base], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (baseResult.exitCode !== 0) {
    return panic("Cannot establish provenance transition base");
  }
  const revision = baseResult.stdout.toString().trim();
  const previousSources = baseSources(root, revision, [
    LEDGER,
    ...Object.keys(ledger),
  ]);
  const previous = previousSources.get(LEDGER);
  const baseLedger = previous === undefined ? undefined : parseLedger(previous);
  const errors: string[] = [];
  const changed = Bun.spawnSync(
    [
      "git",
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      revision,
      "--",
      "apps/api/src",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const untracked = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps/api/src",
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (changed.exitCode !== 0 || untracked.exitCode !== 0) {
    return panic("Cannot discover changed provenance consumers");
  }
  const files = new Set([
    ...registered,
    ...changed.stdout.toString().split("\0"),
    ...untracked.stdout.toString().split("\0"),
  ]);
  for (const file of files) {
    if (
      !/\.[cm]?tsx?$/u.test(file) ||
      file.includes("/tests/") ||
      /\.(?:test|fixture)\.[cm]?tsx?$/u.test(file) ||
      implementations.has(file) ||
      !existsSync(path.join(root, file))
    ) {
      continue;
    }
    const scanned = inspectArtefactGenerators({
      file,
      source: readFileSync(path.join(root, file), "utf-8"),
    });
    errors.push(...assessArtefactGenerator({ file, scanned, ledger }));
  }
  for (const [module, boundary] of Object.entries(MODEL_OPERATION_BOUNDARIES)) {
    const file =
      module === "facade"
        ? "apps/api/src/lib/tanstack-ai-generate.ts"
        : "apps/api/src/lib/chat/tanstack-chat-runtime.ts";
    const exported = exportedModelOperations({
      file,
      source: readFileSync(path.join(root, file), "utf-8"),
    });
    if (JSON.stringify(exported) !== JSON.stringify([...boundary].toSorted())) {
      errors.push(
        `${file}: model-operation boundary registry does not match generation exports`,
      );
    }
  }
  for (const [file, count] of Object.entries(ledger)) {
    if (!registered.has(file) || !existsSync(path.join(root, file))) {
      errors.push(`${file}: transition entry is not a registered generator`);
    }
    const oldSource =
      baseLedger === undefined ? previousSources.get(file) : undefined;
    const maximum =
      baseLedger?.[file] ??
      (oldSource === undefined
        ? 0
        : inspectArtefactGenerators({ file, source: oldSource }).legacyCalls);
    if (count > maximum) {
      errors.push(`${file}: provenance transition list may only shrink`);
    }
  }
  return errors;
};

export const artefactProvenanceGuardSelfTest = () => {
  const file = "apps/api/src/example.ts";
  const source =
    'import { generateTanStackTextForTask as raw } from "@/api/lib/tanstack-ai-generate";';
  const cases = [
    { code: `${source} raw({});`, count: 1 },
    { code: `${source} const alias = raw; alias({}); alias({});`, count: 2 },
    {
      code: `${source} const make = ({ generate = raw }) => generate({});`,
      count: 1,
    },
    {
      code: `${source} function f(generate = raw) { return generate({}); }`,
      count: 1,
    },
    {
      code: 'import * as m from "@/api/lib/tanstack-ai-generate"; m["collectTanStackTextRun"]({});',
      count: 1,
    },
    {
      code: `${source} import { generateArtefact as wrap } from "@/api/lib/generated-artefact-provenance"; wrap({ generate: () => raw({}) });`,
      count: 0,
    },
    {
      code: `${source} function generateArtefact(f) { return f(); } generateArtefact(() => raw({}));`,
      count: 1,
    },
  ];
  cases.push(
    {
      code: `${source} import { generateArtefact as wrap } from "@/api/lib/generated-artefact-provenance"; wrap({ sources: raw({}), generate: () => "text" });`,
      count: 1,
    },
    {
      code: `${source} import { generateArtefact as wrap } from "@/api/lib/generated-artefact-provenance"; function f(wrap) { return wrap({ generate: () => raw({}) }); }`,
      count: 1,
    },
    {
      code: `${source} import { generateArtefact as wrap } from "@/api/lib/generated-artefact-provenance"; function f() { const wrap = (o) => o.generate(); return wrap({ generate: () => raw({}) }); }`,
      count: 1,
    },
    {
      code: `${source} import { generateArtefact as wrap } from "@/api/lib/generated-artefact-provenance"; wrap({ generate() { return raw({}); } });`,
      count: 0,
    },
    {
      code: 'import * as m from "@/api/lib/tanstack-ai-generate"; const { generateTanStackTextForTask: run } = m; run({});',
      count: 1,
    },
    {
      code: 'import * as m from "@/api/lib/tanstack-ai-generate"; m[name]({});',
      count: 1,
    },
    {
      code: `${source} const alias = (true ? raw : raw) satisfies Function; alias({});`,
      count: 1,
    },
    {
      code: 'const m = await import("@/api/lib/tanstack-ai-generate"); m.generateTanStackTextForTask({});',
      count: 1,
    },
  );
  for (const item of cases) {
    if (
      inspectArtefactGenerators({ file, source: item.code }).legacyCalls !==
      item.count
    ) {
      return false;
    }
  }
  const unregistered = assessArtefactGenerator({
    file,
    ledger: {},
    scanned: inspectArtefactGenerators({ file, source: `${source} raw({});` }),
  });
  return (
    unregistered.some((error) =>
      error.includes("unregistered model generator"),
    ) &&
    inspectArtefactGenerators({
      file,
      source: 'db.update(t).set({ ["generationProvenance"]: {} })',
    }).writes.length === 1
  );
};

if (import.meta.main) {
  if (process.argv.includes("--self-test")) {
    if (!artefactProvenanceGuardSelfTest()) {
      process.exit(1);
    }
    console.log("generated artefact provenance detector: PASS");
  } else {
    const errors = checkArtefactProvenance();
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0) {
      process.exit(1);
    }
    console.log("generated artefact provenance census: PASS");
  }
}
