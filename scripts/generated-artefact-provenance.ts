import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { MODEL_OPERATION_NAMES } from "../apps/api/src/lib/model-operation-registry.ts";
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
export const inspectArtefactGenerators = ({ file, source }: ScanOptions) => {
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
      }
    }
  });
  const reference = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      return bindings.has(expression.text);
    }
    if (ts.isParenthesizedExpression(expression)) {
      return reference(expression.expression);
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
      ts.isStringLiteral(expression.argumentExpression)
    ) {
      return (
        namespaces.has(expression.expression.text) &&
        names.has(expression.argumentExpression.text)
      );
    }
    return false;
  };
  // Resolve aliases to a fixed point, including a chain declared before its source.
  let changed = true;
  const resolveAlias = (node: ts.Node) => {
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
  const wrapped = (node: ts.Node) => {
    for (
      let parent = node.parent;
      !ts.isSourceFile(parent);
      parent = parent.parent
    ) {
      if (!ts.isCallExpression(parent)) {
        continue;
      }
      const callee = parent.expression;
      if (ts.isIdentifier(callee) && wrappers.has(callee.text)) {
        return true;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        wrapperNamespaces.has(callee.expression.text) &&
        callee.name.text === "generateArtefact"
      ) {
        return true;
      }
    }
    return false;
  };
  let legacyCalls = 0;
  const writes: number[] = [];
  visit(tree, (node) => {
    if (
      ts.isCallExpression(node) &&
      reference(node.expression) &&
      !wrapped(node)
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
const gitText = (root: string, ref: string): string | undefined => {
  const result = Bun.spawnSync(["git", "show", ref], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
};
type CheckOptions = { root?: string; base?: string };
export const checkArtefactProvenance = async ({
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
  const previous = gitText(root, `${revision}:${LEDGER}`);
  const baseLedger = previous === undefined ? undefined : parseLedger(previous);
  const errors: string[] = [];
  for await (const file of new Bun.Glob("apps/api/src/**/*.ts").scan({
    cwd: root,
  })) {
    if (
      file.includes("/tests/") ||
      /\.(?:test|fixture)\.ts$/u.test(file) ||
      implementations.has(file)
    ) {
      continue;
    }
    const scanned = inspectArtefactGenerators({
      file,
      source: readFileSync(path.join(root, file), "utf-8"),
    });
    errors.push(...assessArtefactGenerator({ file, scanned, ledger }));
  }
  for (const [file, count] of Object.entries(ledger)) {
    if (!registered.has(file) || !existsSync(path.join(root, file))) {
      errors.push(`${file}: transition entry is not a registered generator`);
    }
    const oldSource =
      baseLedger === undefined
        ? gitText(root, `${revision}:${file}`)
        : undefined;
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
    const errors = await checkArtefactProvenance();
    for (const error of errors) {
      console.error(error);
    }
    if (errors.length > 0) {
      process.exit(1);
    }
    console.log("generated artefact provenance census: PASS");
  }
}
