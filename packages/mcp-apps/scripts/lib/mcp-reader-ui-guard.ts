import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

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
  parseSource(file, text).program;
const nodesOf = (source: Node): Node[] => {
  const nodes: Node[] = [];
  walk(source, (node) => {
    nodes.push(node);
  });
  return nodes;
};
const hasJsx = (node: Node) =>
  nodesOf(node).some(
    (child) => child.type === "JSXElement" || child.type === "JSXFragment",
  );
const isReaderOwner = (file: string) =>
  file.startsWith("packages/decision-reader/") ||
  file.startsWith("packages/ui/");

const sharedComponentNames = (sharedModules: readonly ReaderModule[]) => {
  const components = new Set<string>();
  for (const module of sharedModules) {
    for (const statement of parseModule(module).body) {
      if (statement.type === "ExportNamedDeclaration") {
        for (const binding of statement.specifiers) {
          const name =
            binding.exported.type === "Identifier"
              ? binding.exported.name
              : binding.exported.value;
          if (binding.exportKind !== "type" && /^[A-Z][a-z]/u.test(name)) {
            components.add(name);
          }
        }
      }
      if (
        statement.type !== "ExportNamedDeclaration" &&
        statement.type !== "ExportDefaultDeclaration"
      ) {
        continue;
      }
      const node = statement.declaration;
      if (!node) {
        continue;
      }
      if (
        (node.type === "FunctionDeclaration" ||
          node.type === "ClassDeclaration") &&
        node.id &&
        /^[A-Z][a-z]/u.test(node.id.name)
      ) {
        components.add(node.id.name);
      }
      if (node.type !== "VariableDeclaration") {
        continue;
      }
      for (const declaration of node.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          /^[A-Z][a-z]/u.test(declaration.id.name)
        ) {
          components.add(declaration.id.name);
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
        node.type !== "Property" ||
        node.key.type !== "Identifier" ||
        node.key.name !== "type" ||
        node.value.type !== "CallExpression"
      ) {
        continue;
      }
      const value = node.value.arguments.at(0);
      if (value?.type === "Literal" && typeof value.value === "string") {
        astKinds.add(value.value);
      }
    }
  }
  return astKinds;
};

const blockRendererBindings = (nodes: readonly Node[]) => {
  const rendererNames = new Set<string>();
  for (const node of nodes) {
    if (
      node.type !== "ImportDeclaration" ||
      node.source.value !== "@stll/decision-reader/document-ast-text"
    ) {
      continue;
    }
    for (const binding of node.specifiers) {
      if (
        binding.type === "ImportSpecifier" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === "BlockRenderer" &&
        binding.importKind !== "type"
      ) {
        rendererNames.add(binding.local.name);
      }
    }
  }
  return rendererNames;
};

type InspectLocalReaderNodeOptions = {
  node: Node;
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
    (node.type === "VariableDeclarator" ||
      node.type === "FunctionDeclaration" ||
      node.type === "ClassDeclaration") &&
    node.id?.type === "Identifier"
      ? node.id.name
      : undefined;
  if (name && components.has(name)) {
    issues.push(`${file}: local ${name} duplicates shared reader UI`);
  }
  // A renamed renderer cannot evade ownership by switching on AST kinds and painting JSX.
  if (
    ![
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type) ||
    !hasJsx(node)
  ) {
    return;
  }
  const rendersAst = nodesOf(node).some((child) => {
    if (
      child.type === "SwitchCase" &&
      child.test?.type === "Literal" &&
      typeof child.test.value === "string"
    ) {
      return astKinds.has(child.test.value);
    }
    if (
      child.type !== "BinaryExpression" &&
      child.type !== "LogicalExpression" &&
      child.type !== "AssignmentExpression"
    ) {
      return false;
    }
    return (
      [child.left, child.right].some(
        (operand) =>
          operand.type === "Literal" &&
          typeof operand.value === "string" &&
          astKinds.has(operand.value),
      ) &&
      [child.left, child.right].some(
        (operand) =>
          operand.type === "MemberExpression" &&
          !operand.computed &&
          operand.property.type === "Identifier" &&
          operand.property.name === "type",
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
        node.type === "JSXOpeningElement" &&
        node.name.type === "JSXIdentifier" &&
        rendererNames.has(node.name.name),
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
