import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type ArrowFunctionExpression,
  type Expression,
  type Function as FunctionNode,
  type Node,
  type ParsedSource,
  parseSource,
  type VariableDeclarator,
  walk,
} from "../packages/scripts/src/syntax-tree";

type RendererFunction = FunctionNode | ArrowFunctionExpression;
type SourceTree = ParsedSource & { parents: ReadonlyMap<Node, Node> };
const nodeText = (node: Node, file: ParsedSource) =>
  file.sourceText.slice(node.start, node.end);
const isFunctionLike = (node: Node): node is RendererFunction =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";
const isFalse = (node: Node) => node.type === "Literal" && node.value === false;
const visitChildren = (root: Node, visit: (node: Node) => void) => {
  walk(root, (node) => {
    if (node !== root) {
      visit(node);
      return "skip-children";
    }
    return undefined;
  });
};
const statementsOf = (file: ParsedSource) =>
  file.program.body.map((statement) =>
    statement.type === "ExportNamedDeclaration" && statement.declaration
      ? statement.declaration
      : statement,
  );

const BADGE_OWNER = "packages/ui/src/components/document-identity-badge.tsx";
export const REQUIRED_DOCUMENT_IDENTITY_SURFACES = [
  "apps/web/src/features/statutes/statute-inspector-registration.tsx#StatuteRailIcon",
  "apps/web/src/features/statutes/components/statute-search-results.tsx#StatuteSearchResults",
  "apps/web/src/components/search-dialog-results.tsx#SearchHitIcon",
  "apps/web/src/components/search-dialog-results.tsx#RecentFileIcon",
  "apps/web/src/features/case-law/components/decision-cells.tsx#CaseNumberCell",
  "packages/mcp-apps/src/case-law-results/view.tsx#ResultTableRow",
] as const;
const DOCUMENT_ROW_DATA =
  /\b(?:StatuteListItem|StatuteSearchHit|DecisionCitation|LeadingCitation|StatuteViewPayload|ProvisionViewPayload|CaseDecisionViewPayload|statuteTitle|courtAbbreviation|caseNumber|documentIdentity)\b|\bstatute\.title\b|["'](?:statute|decision|case-law)["']/u;
const ROW_TAG =
  /^(?:TableRow|TableCell|li|CommandItem|PublicLawRow|PublicLawTable)$/u;
const DOCUMENT_INPUT =
  /\b(?:StatuteListItem|StatuteSearchHit|DecisionCitation|LeadingCitation|CitingDecisionRow|ResolvedCitedStatute|DecisionRowData|StatuteRowData)\b/u;
const ROW_IDENTITY =
  /\.(?:caseNumber|courtAbbreviation|statuteTitle|decisionId)\b|\bstatute\.title\b/u;

type IdentityBranch = {
  references: Set<string>;
  projectsIdentity: boolean;
};

type Renderer = {
  path: string;
  name: string;
  references: Set<string>;
  rowReferences: Set<string>;
  identityBranches: IdentityBranch[];
  hasJsx: boolean;
  hasRows: boolean;
  carriesDocumentKind: boolean;
};

const resolveImport = (filename: string, specifier: string) => {
  if (specifier === "@stll/ui/document-identity-badge") {
    return BADGE_OWNER;
  }
  if (specifier.startsWith("@stll/decision-reader/")) {
    return `packages/decision-reader/src/${specifier.slice("@stll/decision-reader/".length)}`;
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

/**
 * A code-split component (`lazy(() => import("./x"))`) renders the export its
 * loader resolves to: `default`, or the member mapped onto `default`.
 */
const lazyComponentTarget = (
  declaration: VariableDeclarator,
  file: SourceTree,
) => {
  const call = declaration.init;
  if (
    !call ||
    call.type !== "CallExpression" ||
    !/^(?:React\.)?lazy$/u.test(nodeText(call.callee, file))
  ) {
    return undefined;
  }
  let specifier: string | undefined;
  let member = "default";
  walk(call, (node) => {
    if (
      node.type === "ImportExpression" &&
      node.source.type === "Literal" &&
      typeof node.source.value === "string"
    ) {
      specifier = node.source.value;
    }
    if (
      node.type === "Property" &&
      !node.method &&
      nodeText(node.key, file) === "default" &&
      node.value.type === "MemberExpression" &&
      !node.value.computed &&
      node.value.property.type === "Identifier"
    ) {
      member = node.value.property.name;
    }
  });
  return specifier === undefined ? undefined : { specifier, member };
};

type SourceReferencesOptions = {
  filename: string;
  file: SourceTree;
  sources: ReadonlyMap<string, string>;
};
const sourceReferences = ({
  filename,
  file,
  sources,
}: SourceReferencesOptions) => {
  const imports = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const resolveSource = (specifier: string) => {
    const stem = resolveImport(filename, specifier);
    return stem === null
      ? undefined
      : [stem, `${stem}.tsx`, `${stem}.ts`].find((candidate) =>
          sources.has(candidate),
        );
  };
  for (const statement of statementsOf(file)) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        const lazyTarget = lazyComponentTarget(declaration, file);
        const target =
          lazyTarget === undefined
            ? undefined
            : resolveSource(lazyTarget.specifier);
        if (lazyTarget && target && declaration.id.type === "Identifier") {
          imports.set(declaration.id.name, `${target}#${lazyTarget.member}`);
        }
      }
      continue;
    }
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const target = resolveSource(statement.source.value);
    if (target === undefined) {
      continue;
    }
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportSpecifier") {
        const name =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        imports.set(binding.local.name, `${target}#${name}`);
      } else if (binding.type === "ImportNamespaceSpecifier") {
        namespaces.set(binding.local.name, target);
      } else {
        imports.set(binding.local.name, `${target}#default`);
      }
    }
  }
  return (name: string) => {
    const [namespace, member] = name.split(".");
    const target =
      namespace === undefined ? undefined : namespaces.get(namespace);
    return target !== undefined && member !== undefined
      ? `${target}#${member}`
      : (imports.get(name) ?? `${filename}#${name}`);
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
  expression: Node;
  collect: (name: string, node: RendererFunction) => void;
};

const collectInitializer = ({
  name,
  expression,
  collect,
}: CollectInitializerOptions) => {
  if (
    expression.type === "ArrowFunctionExpression" ||
    expression.type === "FunctionExpression"
  ) {
    collect(name, expression);
    return;
  }
  if (!(expression.type === "CallExpression")) {
    return;
  }
  for (const argument of expression.arguments) {
    if (
      argument.type === "ArrowFunctionExpression" ||
      argument.type === "FunctionExpression"
    ) {
      collect(name, argument);
    }
  }
};

type DocumentRendererOptions = {
  name: string;
  node: RendererFunction;
  file: SourceTree;
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
  const typedDocumentInput = node.params.some((parameter) => {
    if (DOCUMENT_INPUT.test(nodeText(parameter, file))) {
      return true;
    }
    const input =
      parameter.type === "TSParameterProperty"
        ? parameter.parameter
        : parameter;
    const inputType = input.typeAnnotation?.typeAnnotation;
    if (inputType === undefined || !(inputType.type === "TSTypeReference")) {
      return false;
    }
    const inputName = nodeText(inputType.typeName, file);
    return statementsOf(file).some(
      (statement) =>
        statement.type === "TSTypeAliasDeclaration" &&
        statement.id.name === inputName &&
        DOCUMENT_INPUT.test(nodeText(statement.typeAnnotation, file)) &&
        /\[\]|\b(?:ReadonlyArray|Array)</u.test(
          nodeText(statement.typeAnnotation, file),
        ),
    );
  });
  // Maps of language menus, legal text ASTs and charts are not document rows.
  // A row projects an identity value and has a list/table/command slot.
  return (
    (hasRows &&
      (rowProjectsIdentity ||
        typedDocumentInput ||
        /\bDecisionRowData\b/u.test(nodeText(node, file)))) ||
    (hasIdentityValue && name.endsWith("Cell")) ||
    (typedDocumentInput && /Item$|References$/u.test(name)) ||
    (DOCUMENT_ROW_DATA.test(nodeText(node, file)) &&
      /RailIcon$|HitIcon$|Recent.*Icon$/u.test(name))
  );
};

const gatherBindings = (body: Node, bindings: Map<string, Expression>) => {
  const visit = (child: Node) => {
    if (child !== body && isFunctionLike(child)) {
      return;
    }
    if (
      child.type === "VariableDeclarator" &&
      child.id.type === "Identifier" &&
      child.init !== null
    ) {
      bindings.set(child.id.name, child.init);
    }
    visitChildren(child, visit);
  };
  visit(body);
};

type VisitReturnedOutputOptions = {
  body: Node;
  visit: (node: Expression) => void;
};

const visitReturnedOutput = ({ body, visit }: VisitReturnedOutputOptions) => {
  const returned = (child: Node) => {
    if (child !== body && isFunctionLike(child)) {
      return;
    }
    if (child.type === "IfStatement" && isFalse(child.test)) {
      if (child.alternate !== null) {
        returned(child.alternate);
      }
      return;
    }
    if (child.type === "BlockStatement") {
      for (const statement of child.body) {
        returned(statement);
        if (statement.type === "ReturnStatement") {
          break;
        }
      }
      return;
    }
    if (child.type === "ReturnStatement") {
      if (child.argument) {
        visit(child.argument);
      }
      return;
    }
    visitChildren(child, returned);
  };
  returned(body);
};

const documentKindOutputs = (body: Node, file: SourceTree) => {
  const outputs: Expression[] = [];
  const panicBindings = new Set(
    file.program.body.flatMap((statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === "better-result"
        ? statement.specifiers.flatMap((binding) =>
            binding.type === "ImportSpecifier" &&
            (binding.imported.type === "Identifier"
              ? binding.imported.name
              : binding.imported.value) === "panic"
              ? [binding.local.name]
              : [],
          )
        : [],
    ),
  );
  const append = (expression: Expression) => {
    if (expression.type === "ParenthesizedExpression") {
      append(expression.expression);
      return;
    }
    if (expression.type === "ConditionalExpression") {
      if (!isFalse(expression.test)) {
        append(expression.consequent);
      }
      append(expression.alternate);
      return;
    }
    if (
      (expression.type === "Literal" &&
        (expression.value === null || expression.value === false)) ||
      (expression.type === "Identifier" && expression.name === "undefined")
    ) {
      return;
    }
    // A never-returning invariant failure has no rendered document branch.
    if (
      expression.type === "CallExpression" &&
      expression.callee.type === "Identifier" &&
      panicBindings.has(expression.callee.name)
    ) {
      return;
    }
    outputs.push(expression);
  };
  const isDocumentCondition = (condition: Expression) =>
    /\.(?:kind|type|documentKind)\b/u.test(nodeText(condition, file)) &&
    /["'](?:statute|decision|case-law)["']/u.test(nodeText(condition, file));
  const scan = (child: Node) => {
    if (
      child.type === "JSXAttribute" &&
      /^on[A-Z]/u.test(nodeText(child.name, file))
    ) {
      return;
    }
    if (
      child.type === "ConditionalExpression" &&
      isDocumentCondition(child.test)
    ) {
      append(child.consequent);
      append(child.alternate);
    }
    if (child.type === "IfStatement" && isDocumentCondition(child.test)) {
      visitReturnedOutput({ body: child.consequent, visit: append });
      if (child.alternate !== null) {
        visitReturnedOutput({ body: child.alternate, visit: append });
      } else {
        const parent = file.parents.get(child);
        if (parent?.type === "BlockStatement") {
          const position = parent.body.indexOf(child);
          for (const statement of parent.body.slice(position + 1)) {
            visitReturnedOutput({ body: statement, visit: append });
            if (statement.type === "ReturnStatement") {
              break;
            }
          }
        }
      }
    }
    if (
      child.type === "SwitchStatement" &&
      /\.(?:kind|type|documentKind)\b/u.test(nodeText(child.discriminant, file))
    ) {
      for (const [index, clause] of child.cases.entries()) {
        if (
          clause.test?.type !== "Literal" ||
          typeof clause.test.value !== "string" ||
          !/^(?:statute|decision|case-law)$/u.test(clause.test.value)
        ) {
          continue;
        }
        const effective = child.cases
          .slice(index)
          .find((candidate) => candidate.consequent.length > 0);
        for (const statement of effective?.consequent ?? []) {
          visitReturnedOutput({ body: statement, visit: append });
        }
      }
    }
    visitChildren(child, scan);
  };
  scan(body);
  return outputs;
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
    violations: surfaces.filter((id) => {
      const usesBadge = (dependencyId: string) =>
        reachesRenderer({
          id: dependencyId,
          renderers,
          matches: (target) =>
            target === `${BADGE_OWNER}#DocumentIdentityBadge`,
        });
      if (!usesBadge(id)) {
        return true;
      }
      // A shared badge in one kind cannot cover a different kind's output.
      return reachesRenderer({
        id,
        renderers,
        matches: (dependencyId, renderer) =>
          renderer !== undefined &&
          reachesRenderer({
            id: dependencyId,
            renderers,
            matches: (_target, dependency) => dependency?.hasJsx === true,
          }) &&
          renderer.identityBranches.some(
            (branch) =>
              (branch.projectsIdentity ||
                renderer.identityBranches.some((candidate) =>
                  [...candidate.references].some(usesBadge),
                )) &&
              ![...branch.references].some(usesBadge),
          ),
      });
    }),
  };
};

const collectSourceRenderers = (
  file: SourceTree,
  collect: (name: string, node: RendererFunction) => void,
) => {
  for (const statement of statementsOf(file)) {
    if (statement.type === "FunctionDeclaration") {
      collect(statement.id?.name ?? "default", statement);
    }
    if (statement.type === "ExportDefaultDeclaration") {
      if (statement.declaration.type === "FunctionDeclaration") {
        collect("default", statement.declaration);
      } else if (statement.declaration.type !== "ClassDeclaration") {
        collectInitializer({
          name: "default",
          expression: statement.declaration,
          collect,
        });
      }
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === "Identifier" && declaration.init) {
          collectInitializer({
            name: declaration.id.name,
            expression: declaration.init,
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
    const parsed = parseSource(filename, text);
    const parents = new Map<Node, Node>();
    walk(parsed.program, (node, ancestors) => {
      const parent = ancestors.at(-1);
      if (parent) {
        parents.set(node, parent);
      }
    });
    const file = { ...parsed, parents };
    const reference = sourceReferences({ filename, file, sources });
    const collect = (name: string, node: RendererFunction) => {
      const id = `${filename}#${name}`;
      const references = new Set<string>();
      let outputReferences = references;
      const rowReferences = new Set<string>();
      const bindings = new Map<string, Expression>();
      let hasRows = false;
      let rowProjectsIdentity = false;
      let hasJsx = false;
      let hasIdentityValue = false;
      const body = node.body;
      if (body === null) {
        return;
      }
      gatherBindings(body, bindings);
      const visitedBindings = new Set<string>();
      const visitedRowBindings = new Set<string>();
      const visit = (child: Node, rowContext = false) => {
        const inRow =
          rowContext ||
          (child.type === "JSXElement" &&
            ROW_TAG.test(nodeText(child.openingElement.name, file)));
        if (child.type === "Identifier") {
          const initializer = bindings.get(child.name);
          const visited = inRow ? visitedRowBindings : visitedBindings;
          if (initializer !== undefined && !visited.has(child.name)) {
            visited.add(child.name);
            visit(initializer, inRow);
          }
        }
        if (
          child.type === "JSXAttribute" &&
          /^on[A-Z]/u.test(nodeText(child.name, file))
        ) {
          return;
        }
        if (
          child.type === "JSXExpressionContainer" &&
          child.expression.type !== "JSXEmptyExpression" &&
          /\b(?:caseNumber|courtAbbreviation|statuteTitle|documentIdentity)\b/u.test(
            nodeText(child.expression, file),
          )
        ) {
          hasIdentityValue = true;
        }
        if (child.type === "JSXOpeningElement") {
          hasJsx = true;
          const tag = nodeText(child.name, file);
          outputReferences.add(reference(tag));
          if (ROW_TAG.test(tag)) {
            hasRows = true;
            const row = file.parents.get(child) ?? child;
            if (ROW_IDENTITY.test(nodeText(row, file))) {
              rowProjectsIdentity = true;
            }
          }
          if (inRow) {
            rowReferences.add(reference(tag));
          }
        }
        if (child.type === "CallExpression") {
          const dependency = reference(nodeText(child.callee, file));
          outputReferences.add(dependency);
          if (inRow) {
            rowReferences.add(dependency);
          }
        }
        if (
          child.type === "LogicalExpression" &&
          child.operator === "&&" &&
          isFalse(child.left)
        ) {
          return;
        }
        // A literal-false conditional cannot render its consequent.
        if (child.type === "ConditionalExpression" && isFalse(child.test)) {
          visit(child.alternate, inRow);
          return;
        }
        visitChildren(child, (descendant) => visit(descendant, inRow));
      };
      if (body.type === "BlockStatement") {
        visitReturnedOutput({ body, visit });
      } else {
        visit(body);
      }
      const identityBranches: IdentityBranch[] = [];
      if (filename !== BADGE_OWNER) {
        for (const output of documentKindOutputs(body, file)) {
          outputReferences = new Set<string>();
          visitedBindings.clear();
          visitedRowBindings.clear();
          visit(output);
          identityBranches.push({
            references: outputReferences,
            projectsIdentity:
              /\b(?:identity|documentIdentity|CourtBadge|courtAbbreviation|caseNumber|statuteNumber|statuteYear)\b/u.test(
                nodeText(output, file),
              ),
          });
        }
      }
      renderers.set(id, {
        path: filename,
        name,
        references,
        rowReferences,
        identityBranches,
        hasJsx,
        hasRows,
        carriesDocumentKind:
          /\.(?:kind|type|documentKind)\b/u.test(nodeText(node, file)) &&
          /["'](?:statute|decision|case-law)["']/u.test(nodeText(node, file)),
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
    for (const statement of statementsOf(file)) {
      if (
        !(statement.type === "ExpressionStatement") ||
        !(statement.expression.type === "CallExpression")
      ) {
        continue;
      }
      const call = statement.expression;
      if (
        nodeText(call.callee, file) !== "registerInspectorView" ||
        !DOCUMENT_ROW_DATA.test(nodeText(call, file))
      ) {
        continue;
      }
      for (const argument of call.arguments) {
        if (!(argument.type === "ObjectExpression")) {
          continue;
        }
        for (const property of argument.properties) {
          if (
            !(
              property.type === "Property" &&
              !property.method &&
              !property.shorthand &&
              property.kind === "init"
            ) ||
            nodeText(property.key, file) !== "railIcon"
          ) {
            continue;
          }
          roots.add(reference(nodeText(property.value, file)));
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
    "packages/mcp-apps/src",
    "packages/ui/src",
    "packages/decision-reader/src",
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

type DocumentIdentityResult = {
  surfaces: readonly string[];
};

export const missingRequiredSurfaces = (
  result: DocumentIdentityResult,
  required: readonly string[],
) => required.filter((surface) => !result.surfaces.includes(surface));

/**
 * Replace every shared badge with a hand-rolled identity renderer. The guard
 * must then report each surface it discovered, or it can no longer see the
 * rendered badge it claims to enforce.
 */
const withUnsharedBadges = (sources: ReadonlyMap<string, string>) =>
  new Map(
    [...sources].map(([filename, source]) => [
      filename,
      source.includes("<DocumentIdentityBadge")
        ? `${source.replaceAll("<DocumentIdentityBadge", "<UnsharedDocumentIdentityBadge")}
            const UnsharedDocumentIdentityBadge = ({ identity }) =>
              identity.kind === "decision"
                ? <span>{identity.courtAbbreviation}</span>
                : <span>{identity.number}/{identity.year}</span>;`
        : source,
    ]),
  );

/** Discovered surfaces whose badge removal the guard would not report. */
export const undetectedBadgeRemovals = (
  sources: ReadonlyMap<string, string>,
  surfaces: readonly string[],
) => {
  const reported = new Set(
    checkDocumentIdentitySources(withUnsharedBadges(sources)).violations,
  );
  return surfaces.filter((surface) => !reported.has(surface));
};

if (import.meta.main) {
  const sources = readDocumentIdentitySources(process.cwd());
  const result = checkDocumentIdentitySources(sources);
  const missing = missingRequiredSurfaces(
    result,
    REQUIRED_DOCUMENT_IDENTITY_SURFACES,
  );
  const undetected = undetectedBadgeRemovals(sources, result.surfaces);
  for (const surface of undetected) {
    console.error(
      `Removing the shared badge from this surface would go unreported: ${surface}`,
    );
  }
  for (const violation of result.violations) {
    console.error(
      `Document row or rail must render DocumentIdentityBadge: ${violation}`,
    );
  }
  for (const surface of missing) {
    console.error(
      `Required document identity surface was not discovered: ${surface}`,
    );
  }
  if (
    result.violations.length > 0 ||
    missing.length > 0 ||
    undetected.length > 0
  ) {
    process.exitCode = 1;
  } else {
    console.log(
      `Document identity: ${result.surfaces.length} renderers use the shared badge.`,
    );
  }
}
