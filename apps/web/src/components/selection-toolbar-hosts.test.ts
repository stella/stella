import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const primitive = path.join(sourceRoot, "components/selection-toolbar.tsx");
const modules = [...new Bun.Glob("**/*.tsx").scanSync({ cwd: sourceRoot })]
  .filter((file) => !file.endsWith(".test.tsx"))
  .map((file) => ({
    file: path.join(sourceRoot, file),
    text: readFileSync(path.join(sourceRoot, file), "utf-8"),
  }));
const resolveImport = (owner: string, specifier: string) =>
  specifier.startsWith("@/")
    ? path.join(sourceRoot, `${specifier.slice(2)}.tsx`)
    : path.resolve(path.dirname(owner), `${specifier}.tsx`);

type ToolbarMount = {
  file: string;
  component: string;
  props: readonly string[];
};
const mountCache = new Map<string, ToolbarMount[]>();
const trees = new Map<string, ts.SourceFile>();
const mountsOf = (target: string): ToolbarMount[] => {
  const cached = mountCache.get(target);
  if (cached !== undefined) {
    return cached;
  }
  const mounts: ToolbarMount[] = [];
  for (const { file, text } of modules) {
    if (!text.includes(path.basename(target, ".tsx"))) {
      continue;
    }
    const tree =
      trees.get(file) ??
      ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
    trees.set(file, tree);
    const importedNames = new Set<string>();
    for (const statement of tree.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        resolveImport(file, statement.moduleSpecifier.text) !== target
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          importedNames.add(entry.name.text);
        }
      }
    }
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        importedNames.has(node.tagName.text)
      ) {
        let owner = node.parent;
        let component = "";
        while (!ts.isSourceFile(owner)) {
          if (
            ts.isVariableStatement(owner) &&
            owner.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            )
          ) {
            const declaration = owner.declarationList.declarations.at(0);
            if (
              declaration !== undefined &&
              ts.isIdentifier(declaration.name)
            ) {
              component = declaration.name.text;
            }
            break;
          }
          if (
            ts.isFunctionDeclaration(owner) &&
            owner.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            )
          ) {
            component = owner.name?.text ?? "";
            break;
          }
          owner = owner.parent;
        }
        mounts.push({
          file,
          component,
          props: node.attributes.properties.flatMap((attribute) =>
            ts.isJsxAttribute(attribute) ? [attribute.name.getText(tree)] : [],
          ),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  mountCache.set(target, mounts);
  return mounts;
};

const wrappers = mountsOf(primitive);
const discoveredHosts = wrappers.flatMap(({ file }) => mountsOf(file));
const hosts = discoveredHosts.filter(
  (host, index) =>
    discoveredHosts.findIndex(
      (candidate) =>
        candidate.file === host.file && candidate.component === host.component,
    ) === index,
);
test("every discovered selection toolbar mount supplies its own clipping boundary", () => {
  expect(wrappers.length).toBeGreaterThan(0);
  // Branches can mount the primitive more than once in the same owner.
  // Compare owners while still checking every primitive mount below.
  const wrapperOwners = wrappers.filter(
    (wrapper, index) =>
      wrappers.findIndex(
        (candidate) =>
          candidate.file === wrapper.file &&
          candidate.component === wrapper.component,
      ) === index,
  );
  expect(hosts.length).toBeGreaterThan(wrapperOwners.length);
  for (const wrapper of wrappers) {
    expect(wrapper.component).not.toBe("");
    expect(wrapper.props).toContain("anchorRect");
    expect(wrapper.props).toContain("boundaryRect");
    const tree = trees.get(wrapper.file);
    expect(tree).toBeDefined();
    const canonicalNames = new Set<string>();
    for (const statement of tree?.statements ?? []) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !==
          "@/components/selection-toolbar.logic"
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const entry of bindings.elements) {
          if (
            (entry.propertyName ?? entry.name).text === "selectionToolbarAnchor"
          ) {
            canonicalNames.add(entry.name.text);
          }
        }
      }
    }
    expect(canonicalNames.size).toBeGreaterThan(0);
    let callsSharedAnchor = false;
    const findAnchorCall = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        canonicalNames.has(node.expression.text)
      ) {
        callsSharedAnchor = true;
      }
      ts.forEachChild(node, findAnchorCall);
    };
    if (tree !== undefined) {
      findAnchorCall(tree);
    }
    expect(callsSharedAnchor).toBe(true);
    expect(
      hosts.some((host) =>
        mountsOf(wrapper.file).some((consumer) => consumer.file === host.file),
      ),
    ).toBe(true);
  }
});

for (const host of hosts) {
  test(`${path.relative(sourceRoot, host.file)}: ${host.component} inherits the shared bounded selection toolbar`, () => {
    expect(host.component).not.toBe("");
    expect(
      wrappers.some((wrapper) =>
        mountsOf(wrapper.file).some(
          (consumer) =>
            consumer.file === host.file &&
            consumer.component === host.component,
        ),
      ),
    ).toBe(true);
  });
}
