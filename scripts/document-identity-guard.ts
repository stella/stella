import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const BADGE_OWNER = "packages/ui/src/components/document-identity-badge.tsx";
const DOCUMENT_ROW_DATA =
  /\b(?:StatuteListItem|StatuteSearchHit|DecisionCitation|LeadingCitation|StatuteViewPayload|ProvisionViewPayload|CaseDecisionViewPayload|statuteTitle|courtAbbreviation|caseNumber|documentIdentity)\b|\bstatute\.title\b|["'](?:statute|decision|case-law)["']/u;
const ROW_TAG =
  /^(?:TableRow|TableCell|li|CommandItem|PublicLawRow|PublicLawTable)$/u;
const DOCUMENT_INPUT =
  /\b(?:StatuteListItem|StatuteSearchHit|DecisionCitation|LeadingCitation|CitingDecisionRow|ResolvedCitedStatute|DecisionRowData|StatuteRowData)\b/u;
const ROW_IDENTITY =
  /\.(?:caseNumber|courtAbbreviation|statuteTitle|decisionId)\b|\bstatute\.title\b/u;

type Renderer = {
  path: string;
  name: string;
  references: Set<string>;
  rowReferences: Set<string>;
  hasRows: boolean;
  carriesDocumentKind: boolean;
};

const resolveImport = (filename: string, specifier: string) => {
  if (specifier === "@stll/ui/document-identity-badge") {
    return BADGE_OWNER;
  }
  if (specifier.startsWith("@/api/")) {
    return `apps/api/src/${specifier.slice(6)}`;
  }
  if (specifier.startsWith("@/")) {
    return `apps/web/src/${specifier.slice(2)}`;
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(filename), specifier))
    .replace(/\.(?:tsx?|jsx?)$/u, "");
};

type SourceReferencesOptions = {
  filename: string;
  file: ts.SourceFile;
  sources: ReadonlyMap<string, string>;
};

const sourceReferences = ({
  filename,
  file,
  sources,
}: SourceReferencesOptions) => {
  const imports = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const stem = resolveImport(filename, statement.moduleSpecifier.text);
    const target =
      stem === null
        ? undefined
        : [stem, `${stem}.tsx`, `${stem}.ts`].find((candidate) =>
            sources.has(candidate),
          );
    if (target === undefined) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        imports.set(
          binding.name.text,
          `${target}#${binding.propertyName?.text ?? binding.name.text}`,
        );
      }
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, target);
    }
    const defaultName = statement.importClause?.name;
    if (defaultName !== undefined) {
      imports.set(defaultName.text, `${target}#default`);
    }
  }
  return (name: string) => {
    const [namespace, member] = name.split(".");
    const target =
      namespace === undefined ? undefined : namespaces.get(namespace);
    if (target !== undefined && member !== undefined) {
      return `${target}#${member}`;
    }
    return imports.get(name) ?? `${filename}#${name}`;
  };
};

type RendererReachabilityOptions = {
  id: string;
  renderers: ReadonlyMap<string, Renderer>;
  matches: (id: string, renderer: Renderer | undefined) => boolean;
  visited?: Set<string>;
};

const reachesRenderer = ({
  id,
  renderers,
  matches,
  visited = new Set<string>(),
}: RendererReachabilityOptions): boolean => {
  if (matches(id, renderers.get(id))) {
    return true;
  }
  if (visited.has(id)) {
    return false;
  }
  visited.add(id);
  const renderer = renderers.get(id);
  if (renderer === undefined) {
    return false;
  }
  return [...renderer.references].some((dependency) =>
    reachesRenderer({ id: dependency, renderers, matches, visited }),
  );
};

type CollectInitializerOptions = {
  name: string;
  expression: ts.Expression;
  collect: (name: string, node: ts.FunctionLikeDeclaration) => void;
};

const collectInitializer = ({
  name,
  expression,
  collect,
}: CollectInitializerOptions) => {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    collect(name, expression);
    return;
  }
  if (!ts.isCallExpression(expression)) {
    return;
  }
  for (const argument of expression.arguments) {
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      collect(name, argument);
    }
  }
};

type DocumentRendererOptions = {
  name: string;
  node: ts.FunctionLikeDeclaration;
  file: ts.SourceFile;
  hasJsx: boolean;
  hasRows: boolean;
  rowProjectsIdentity: boolean;
  hasIdentityValue: boolean;
};

const isDocumentRenderer = ({
  name,
  node,
  file,
  hasJsx,
  hasRows,
  rowProjectsIdentity,
  hasIdentityValue,
}: DocumentRendererOptions) => {
  if (!hasJsx) {
    return false;
  }
  const typedDocumentInput = node.parameters.some((parameter) => {
    if (DOCUMENT_INPUT.test(parameter.getText(file))) {
      return true;
    }
    const inputType = parameter.type;
    if (inputType === undefined || !ts.isTypeReferenceNode(inputType)) {
      return false;
    }
    const inputName = inputType.typeName.getText(file);
    return file.statements.some(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) &&
        statement.name.text === inputName &&
        DOCUMENT_INPUT.test(statement.type.getText(file)) &&
        /\[\]|\b(?:ReadonlyArray|Array)</u.test(statement.type.getText(file)),
    );
  });
  // Maps of language menus, legal text ASTs and charts are not document rows.
  // A row projects an identity value and has a list/table/command slot.
  return (
    (hasRows &&
      (rowProjectsIdentity ||
        typedDocumentInput ||
        /\bDecisionRowData\b/u.test(node.getText(file)))) ||
    (hasIdentityValue && name.endsWith("Cell")) ||
    (typedDocumentInput && /Item$|References$/u.test(name)) ||
    (DOCUMENT_ROW_DATA.test(node.getText(file)) &&
      /RailIcon$|HitIcon$|Recent.*Icon$/u.test(name))
  );
};

const gatherBindings = (
  body: ts.Node,
  bindings: Map<string, ts.Expression>,
) => {
  const visit = (child: ts.Node) => {
    if (child !== body && ts.isFunctionLike(child)) {
      return;
    }
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.initializer !== undefined
    ) {
      bindings.set(child.name.text, child.initializer);
    }
    ts.forEachChild(child, visit);
  };
  visit(body);
};

const documentIdentityResult = (
  renderers: ReadonlyMap<string, Renderer>,
  roots: Set<string>,
) => {
  for (const [id, renderer] of renderers) {
    if (
      renderer.hasRows &&
      [...renderer.rowReferences].some((dependencyId) =>
        reachesRenderer({
          id: dependencyId,
          renderers,
          matches: (_id, dependency) =>
            dependency?.carriesDocumentKind === true,
        }),
      )
    ) {
      roots.add(id);
    }
  }
  const surfaces = [...roots].toSorted();
  return {
    surfaces,
    violations: surfaces.filter(
      (id) =>
        !reachesRenderer({
          id,
          renderers,
          matches: (dependencyId) =>
            dependencyId === `${BADGE_OWNER}#DocumentIdentityBadge`,
        }),
    ),
  };
};

const collectSourceRenderers = (
  file: ts.SourceFile,
  collect: (name: string, node: ts.FunctionLikeDeclaration) => void,
) => {
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      collect(statement.name?.text ?? "default", statement);
    }
    if (ts.isExportAssignment(statement)) {
      collectInitializer({
        name: "default",
        expression: statement.expression,
        collect,
      });
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer !== undefined
        ) {
          collectInitializer({
            name: declaration.name.text,
            expression: declaration.initializer,
            collect,
          });
        }
      }
    }
  }
};

/** Discover document rows and registered rails, then follow their rendered output. */
export const checkDocumentIdentitySources = (
  sources: ReadonlyMap<string, string>,
) => {
  const renderers = new Map<string, Renderer>();
  const roots = new Set<string>();

  for (const [filename, text] of sources) {
    const file = ts.createSourceFile(
      filename,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const reference = sourceReferences({ filename, file, sources });
    const collect = (name: string, node: ts.FunctionLikeDeclaration) => {
      const id = `${filename}#${name}`;
      const references = new Set<string>();
      const rowReferences = new Set<string>();
      const bindings = new Map<string, ts.Expression>();
      let hasRows = false;
      let rowProjectsIdentity = false;
      let hasJsx = false;
      let hasIdentityValue = false;
      const body = node.body;
      if (body === undefined) {
        return;
      }
      gatherBindings(body, bindings);
      const visitedBindings = new Set<string>();
      const visitedRowBindings = new Set<string>();
      const visit = (child: ts.Node, rowContext = false) => {
        const inRow =
          rowContext ||
          (ts.isJsxElement(child) &&
            ROW_TAG.test(child.openingElement.tagName.getText(file))) ||
          (ts.isJsxSelfClosingElement(child) &&
            ROW_TAG.test(child.tagName.getText(file)));
        if (ts.isIdentifier(child)) {
          const initializer = bindings.get(child.text);
          const visited = inRow ? visitedRowBindings : visitedBindings;
          if (initializer !== undefined && !visited.has(child.text)) {
            visited.add(child.text);
            visit(initializer, inRow);
          }
        }
        if (
          ts.isJsxAttribute(child) &&
          /^on[A-Z]/u.test(child.name.getText(file))
        ) {
          return;
        }
        if (
          ts.isJsxExpression(child) &&
          child.expression !== undefined &&
          /\b(?:caseNumber|courtAbbreviation|statuteTitle|documentIdentity)\b/u.test(
            child.expression.getText(file),
          )
        ) {
          hasIdentityValue = true;
        }
        if (
          ts.isJsxOpeningElement(child) ||
          ts.isJsxSelfClosingElement(child)
        ) {
          hasJsx = true;
          const tag = child.tagName.getText(file);
          references.add(reference(tag));
          if (ROW_TAG.test(tag)) {
            hasRows = true;
            const row = ts.isJsxOpeningElement(child) ? child.parent : child;
            if (ROW_IDENTITY.test(row.getText(file))) {
              rowProjectsIdentity = true;
            }
          }
          if (inRow) {
            rowReferences.add(reference(tag));
          }
        }
        if (ts.isCallExpression(child)) {
          const dependency = reference(child.expression.getText(file));
          references.add(dependency);
          if (inRow) {
            rowReferences.add(dependency);
          }
        }
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          child.left.kind === ts.SyntaxKind.FalseKeyword
        ) {
          return;
        }
        // A literal-false conditional cannot render its consequent.
        if (
          ts.isConditionalExpression(child) &&
          child.condition.kind === ts.SyntaxKind.FalseKeyword
        ) {
          visit(child.whenFalse, inRow);
          return;
        }
        ts.forEachChild(child, (descendant) => visit(descendant, inRow));
      };
      const returned = (child: ts.Node) => {
        if (child !== body && ts.isFunctionLike(child)) {
          return;
        }
        if (
          ts.isIfStatement(child) &&
          child.expression.kind === ts.SyntaxKind.FalseKeyword
        ) {
          if (child.elseStatement !== undefined) {
            returned(child.elseStatement);
          }
          return;
        }
        if (ts.isBlock(child)) {
          for (const statement of child.statements) {
            returned(statement);
            if (ts.isReturnStatement(statement)) {
              break;
            }
          }
          return;
        }
        if (ts.isReturnStatement(child)) {
          if (child.expression !== undefined) {
            visit(child.expression);
          }
          return;
        }
        ts.forEachChild(child, returned);
      };
      if (ts.isBlock(body)) {
        returned(body);
      } else {
        visit(body);
      }
      renderers.set(id, {
        path: filename,
        name,
        references,
        rowReferences,
        hasRows,
        carriesDocumentKind:
          /\.(?:kind|type|documentKind)\b/u.test(node.getText(file)) &&
          /["'](?:statute|decision|case-law)["']/u.test(node.getText(file)),
      });
      if (
        isDocumentRenderer({
          name,
          node,
          file,
          hasJsx,
          hasRows,
          rowProjectsIdentity,
          hasIdentityValue,
        })
      ) {
        roots.add(id);
      }
    };
    collectSourceRenderers(file, collect);
    for (const statement of file.statements) {
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isCallExpression(statement.expression)
      ) {
        continue;
      }
      const call = statement.expression;
      if (
        call.expression.getText(file) !== "registerInspectorView" ||
        !DOCUMENT_ROW_DATA.test(call.getText(file))
      ) {
        continue;
      }
      for (const argument of call.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) {
          continue;
        }
        for (const property of argument.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            property.name.getText(file) !== "railIcon"
          ) {
            continue;
          }
          roots.add(reference(property.initializer.getText(file)));
        }
      }
    }
  }
  return documentIdentityResult(renderers, roots);
};

export const readDocumentIdentitySources = (root: string) => {
  const sources = new Map<string, string>();
  for (const scope of [
    "apps/web/src",
    "apps/api/src/mcp/apps",
    "packages/ui/src",
  ]) {
    for (const filename of new Bun.Glob("**/*.{ts,tsx}").scanSync({
      cwd: path.join(root, scope),
    })) {
      if (/\.(?:test|spec)\.|\/fixtures\//u.test(filename)) {
        continue;
      }
      const relative = `${scope}/${filename}`;
      sources.set(relative, readFileSync(path.join(root, relative), "utf-8"));
    }
  }
  return sources;
};

if (import.meta.main) {
  const result = checkDocumentIdentitySources(
    readDocumentIdentitySources(process.cwd()),
  );
  for (const violation of result.violations) {
    console.error(
      `Document row or rail must render DocumentIdentityBadge: ${violation}`,
    );
  }
  if (result.violations.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `Document identity: ${result.surfaces.length} renderers use the shared badge.`,
    );
  }
}
