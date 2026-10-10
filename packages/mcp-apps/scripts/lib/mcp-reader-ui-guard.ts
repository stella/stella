import { ts } from "@stll/scripts/src/typescript-program";

export const MCP_READER_UI_APP_DIRECTORIES = [
  "case-law-results",
  "decision-reader",
] as const;

type ReaderModule = { file: string; text: string };
type InspectMcpReaderUiOptions = {
  /** Package export targets, including modules the current app does not use. */
  sharedModules: readonly ReaderModule[];
  astModules: readonly ReaderModule[];
  /** Actual reachable inputs reported by the bundler, never an import-string census. */
  bundleModules: readonly ReaderModule[];
};

const parseModule = ({ file, text }: ReaderModule) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const nodesOf = (source: ts.Node): ts.Node[] => {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
};
const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  ts
    .getModifiers(node)
    ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);
const hasJsx = (node: ts.Node) =>
  nodesOf(node).some(
    (child) =>
      ts.isJsxElement(child) ||
      ts.isJsxSelfClosingElement(child) ||
      ts.isJsxFragment(child),
  );
const isReaderOwner = (file: string) =>
  file.startsWith("packages/decision-reader/") ||
  file.startsWith("packages/ui/");

const sharedComponentNames = (sharedModules: readonly ReaderModule[]) => {
  const components = new Set<string>();
  for (const module of sharedModules) {
    for (const node of parseModule(module).statements) {
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const binding of node.exportClause.elements) {
          if (!binding.isTypeOnly && /^[A-Z][a-z]/u.test(binding.name.text)) {
            components.add(binding.name.text);
          }
        }
      }
      if (!exported(node)) {
        continue;
      }
      if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name &&
        /^[A-Z][a-z]/u.test(node.name.text)
      ) {
        components.add(node.name.text);
      }
      if (!ts.isVariableStatement(node)) {
        continue;
      }
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          /^[A-Z][a-z]/u.test(declaration.name.text)
        ) {
          components.add(declaration.name.text);
        }
      }
    }
  }
  return components;
};

const schemaAstKinds = (astModules: readonly ReaderModule[]) => {
  // Derive discriminators from the owning schemas rather than maintaining a second kind list.
  const astKinds = new Set<string>();
  for (const module of astModules) {
    for (const node of nodesOf(parseModule(module))) {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "type" &&
        ts.isCallExpression(node.initializer)
      ) {
        const value = node.initializer.arguments.at(0);
        if (value && ts.isStringLiteral(value)) {
          astKinds.add(value.text);
        }
      }
    }
  }
  return astKinds;
};

const blockRendererBindings = (nodes: readonly ts.Node[]) => {
  const rendererNames = new Set<string>();
  for (const node of nodes) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@stll/decision-reader/document-ast-text" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const binding of node.importClause.namedBindings.elements) {
        if (
          (binding.propertyName?.text ?? binding.name.text) ===
            "BlockRenderer" &&
          !binding.isTypeOnly
        ) {
          rendererNames.add(binding.name.text);
        }
      }
    }
  }
  return rendererNames;
};

type InspectLocalReaderNodeOptions = {
  node: ts.Node;
  file: string;
  components: ReadonlySet<string>;
  astKinds: ReadonlySet<string>;
  issues: string[];
};
const inspectLocalReaderNode = ({
  node,
  file,
  components,
  astKinds,
  issues,
}: InspectLocalReaderNodeOptions) => {
  const name =
    (ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
      ? node.name.text
      : undefined;
  if (name && components.has(name)) {
    issues.push(`${file}: local ${name} duplicates shared reader UI`);
  }
  // A renamed renderer cannot evade ownership by switching on AST kinds and painting JSX.
  if (!ts.isFunctionLike(node) || !hasJsx(node)) {
    return;
  }
  const rendersAst = nodesOf(node).some((child) => {
    if (ts.isCaseClause(child) && ts.isStringLiteral(child.expression)) {
      return astKinds.has(child.expression.text);
    }
    if (!ts.isBinaryExpression(child)) {
      return false;
    }
    return (
      [child.left, child.right].some(
        (operand) => ts.isStringLiteral(operand) && astKinds.has(operand.text),
      ) &&
      [child.left, child.right].some(
        (operand) =>
          ts.isPropertyAccessExpression(operand) &&
          operand.name.text === "type",
      )
    );
  });
  if (rendersAst) {
    issues.push(
      `${file}: local legal AST UI must use the shared reader renderer`,
    );
  }
};

/**
 * Owns rendering ownership in shipped bundles: every reachable reader UI
 * definition belongs to the shared package, regardless of import indirection.
 */
export const inspectMcpReaderUi = ({
  sharedModules,
  astModules,
  bundleModules,
}: InspectMcpReaderUiOptions): string[] => {
  const components = sharedComponentNames(sharedModules);
  const astKinds = schemaAstKinds(astModules);
  const issues: string[] = [];
  let usesBlockRenderer = false;
  for (const module of bundleModules) {
    if (
      isReaderOwner(module.file) ||
      !/^(?:apps|packages)\//u.test(module.file)
    ) {
      continue;
    }
    const nodes = nodesOf(parseModule(module));
    const rendererNames = blockRendererBindings(nodes);
    for (const node of nodes) {
      inspectLocalReaderNode({
        node,
        file: module.file,
        components,
        astKinds,
        issues,
      });
    }
    usesBlockRenderer ||= nodes.some(
      (node) =>
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) &&
        rendererNames.has(node.tagName.text),
    );
  }
  if (
    !bundleModules.some(
      ({ file }) =>
        file === "packages/decision-reader/src/document-ast-text.tsx",
    )
  ) {
    issues.push(
      "Shared document-ast-text renderer is absent from the bundle inputs",
    );
  }
  if (!usesBlockRenderer) {
    issues.push(
      "MCP reader must render BlockRenderer from @stll/decision-reader/document-ast-text",
    );
  }
  return [...new Set(issues)];
};
