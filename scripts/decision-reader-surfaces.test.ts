import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { DECISION_READER_SURFACES } from "../apps/web/src/features/case-law/decision-reader-surfaces";

type ReaderRegistry = Readonly<Record<string, string>>;
type ReaderSource = { file: string; text: string };
type ImportedSymbols = {
  names: Set<string>;
  namespaces: Set<string>;
  member: string;
};
type ReaderImports = {
  reader: ImportedSymbols;
  hook: ImportedSymbols;
  blocks: ImportedSymbols;
};
type ReaderElement = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

const functionScope = (node: ts.Node): ts.Node => {
  let scope = node.parent;
  while (
    !ts.isSourceFile(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isMethodDeclaration(scope)
  ) {
    scope = scope.parent;
  }
  return scope;
};

const collectNodes = (source: ts.SourceFile): ts.Node[] => {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
};

const importedSymbols = (member: string): ImportedSymbols => ({
  names: new Set(),
  namespaces: new Set(),
  member,
});

const namedExpression = (
  expression: ts.Node,
  symbols: ImportedSymbols,
): boolean =>
  ts.isIdentifier(expression)
    ? symbols.names.has(expression.text)
    : ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      symbols.namespaces.has(expression.expression.text) &&
      expression.name.text === symbols.member;

const readImports = (nodes: readonly ts.Node[]): ReaderImports => {
  const imports = {
    reader: importedSymbols("DecisionText"),
    hook: importedSymbols("useDecisionProvisionAnchors"),
    blocks: importedSymbols("visibleDecisionBlocks"),
  };
  const modules = [
    { suffix: "/decision-text", symbols: imports.reader },
    { suffix: "/use-decision-provision-anchors", symbols: imports.hook },
    { suffix: "/decision-text.logic", symbols: imports.blocks },
  ];
  for (const node of nodes) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    ) {
      continue;
    }
    const moduleName = node.moduleSpecifier.text.replace(
      /\.[cm]?[jt]sx?$/u,
      "",
    );
    const symbols = modules.find(({ suffix }) =>
      moduleName.endsWith(suffix),
    )?.symbols;
    const bindings = node.importClause?.namedBindings;
    if (!symbols || !bindings) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      symbols.namespaces.add(bindings.name.text);
      continue;
    }
    for (const binding of bindings.elements) {
      if (
        (binding.propertyName?.text ?? binding.name.text) === symbols.member
      ) {
        symbols.names.add(binding.name.text);
      }
    }
  }
  return imports;
};

const includeReaderAliases = (
  nodes: readonly ts.Node[],
  reader: ImportedSymbols,
) => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !node.initializer
      ) {
        continue;
      }
      if (
        namedExpression(node.initializer, reader) &&
        !reader.names.has(node.name.text)
      ) {
        reader.names.add(node.name.text);
        changed = true;
      }
    }
  }
};

const readBindings = (nodes: readonly ts.Node[]) => {
  const byScope = new Map<ts.Node, Map<string, ts.Expression | undefined>>();
  for (const node of nodes) {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      continue;
    }
    const scope = functionScope(node);
    let bindings = byScope.get(scope);
    if (!bindings) {
      bindings = new Map();
      byScope.set(scope, bindings);
    }
    bindings.set(node.name.text, node.initializer);
  }
  return byScope;
};

const jsxAttribute = (
  node: ReaderElement,
  name: string,
): ts.JsxAttributeValue | undefined =>
  node.attributes.properties
    .filter(ts.isJsxAttribute)
    .find((attribute) => attribute.name.getText() === name)?.initializer;

const jsxExpression = (
  node: ReaderElement,
  name: string,
): ts.Expression | undefined => {
  const attribute = jsxAttribute(node, name);
  return attribute && ts.isJsxExpression(attribute)
    ? attribute.expression
    : undefined;
};

const objectProperty = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined => {
  for (const property of object.properties) {
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    ) {
      return property.name;
    }
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
};

const sameExpression = (
  left: ts.Expression | undefined,
  right: ts.Expression | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.getText() === right.getText();

type HookContractOptions = {
  node: ReaderElement;
  hookCall: ts.CallExpression;
  expected: string;
  imports: ReaderImports;
};

/** The loader must resolve exactly the decision and text form this reader renders. */
const hookContractFindings = ({
  node,
  hookCall,
  expected,
  imports,
}: HookContractOptions): string[] => {
  const input = hookCall.arguments.at(0);
  if (
    !input ||
    !ts.isObjectLiteralExpression(input) ||
    input.properties.some(ts.isSpreadAssignment)
  ) {
    return ["provision loader must declare its reader inputs explicitly"];
  }
  const findings: string[] = [];
  const surface = objectProperty(input, "surface");
  if (!surface || !ts.isStringLiteral(surface) || surface.text !== expected) {
    findings.push("provision loader surface must match the registered surface");
  }
  if (
    !sameExpression(
      objectProperty(input, "decisionId"),
      jsxExpression(node, "decisionId"),
    )
  ) {
    findings.push(
      "provision loader decisionId must match DecisionText decisionId",
    );
  }
  const blocks = objectProperty(input, "blocks");
  if (
    !blocks ||
    !ts.isCallExpression(blocks) ||
    !namedExpression(blocks.expression, imports.blocks)
  ) {
    findings.push(
      "provision loader blocks must come from visibleDecisionBlocks",
    );
    return findings;
  }
  const fulltext = blocks.arguments.at(2);
  if (
    !fulltext ||
    !ts.isPropertyAccessExpression(fulltext) ||
    fulltext.name.text !== "fulltext" ||
    !sameExpression(fulltext.expression, jsxExpression(node, "decision"))
  ) {
    findings.push(
      "visibleDecisionBlocks must receive this DecisionText decision's fulltext",
    );
  }
  return findings;
};

type ConsumerInspectionOptions = {
  node: ReaderElement;
  expected: string | undefined;
  sourcePath: string;
  imports: ReaderImports;
  bindings: ReturnType<typeof readBindings>;
};

const inspectConsumer = ({
  node,
  expected,
  sourcePath,
  imports,
  bindings,
}: ConsumerInspectionOptions): string[] => {
  if (expected === undefined) {
    return ["unregistered DecisionText consumer"];
  }
  const findings: string[] = [];
  if (node.attributes.properties.some(ts.isJsxSpreadAttribute)) {
    findings.push("spread props cannot override registered reader contracts");
  }
  const surface = jsxAttribute(node, "surface");
  if (!surface || !ts.isStringLiteral(surface) || surface.text !== expected) {
    findings.push(`surface must be the literal ${expected}`);
  }
  if (expected === "development") {
    if (!sourcePath.startsWith("apps/web/src/routes/dev/")) {
      findings.push("development exemption outside routes/dev");
    }
    return findings;
  }
  const provision = jsxExpression(node, "provisionAnchors");
  const hookCall =
    provision && ts.isIdentifier(provision)
      ? bindings.get(functionScope(node))?.get(provision.text)
      : undefined;
  if (
    !hookCall ||
    !ts.isCallExpression(hookCall) ||
    !namedExpression(hookCall.expression, imports.hook)
  ) {
    findings.push(
      "provisionAnchors must receive this reader's useDecisionProvisionAnchors result",
    );
    return findings;
  }
  findings.push(...hookContractFindings({ node, hookCall, expected, imports }));
  return findings;
};

const inspectSource = (
  { file, text }: ReaderSource,
  registry: ReaderRegistry,
) => {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const nodes = collectNodes(source);
  const imports = readImports(nodes);
  includeReaderAliases(nodes, imports.reader);
  const bindings = readBindings(nodes);
  const expected = Object.entries(registry).find(
    ([, registered]) => registered === file,
  )?.[0];
  const findings: string[] = [];
  let consumerCount = 0;
  for (const node of nodes) {
    if (
      (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) ||
      !namedExpression(node.tagName, imports.reader)
    ) {
      continue;
    }
    consumerCount += 1;
    findings.push(
      ...inspectConsumer({
        node,
        expected,
        sourcePath: file,
        imports,
        bindings,
      }).map((finding) => `${file}: ${finding}`),
    );
  }
  if (
    (imports.reader.names.size > 0 || imports.reader.namespaces.size > 0) &&
    consumerCount === 0
  ) {
    findings.push(
      `${file}: DecisionText import has no enumerated JSX consumer`,
    );
  }
  return { findings, consumed: consumerCount > 0 };
};

/** Enumerates source consumers, including renamed and namespace imports. */
const inspectReaderSurfaces = (
  sources: readonly ReaderSource[],
  registry: ReaderRegistry,
): string[] => {
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const readerSource of sources) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(readerSource.file)) {
      continue;
    }
    const result = inspectSource(readerSource, registry);
    findings.push(...result.findings);
    if (result.consumed) {
      seen.add(readerSource.file);
    }
  }
  for (const registeredPath of Object.values(registry)) {
    if (!seen.has(registeredPath)) {
      findings.push(
        `${registeredPath}: registered reader has no DecisionText consumer`,
      );
    }
  }
  return findings;
};

const fixturePath = "apps/web/src/features/case-law/reader.tsx";
const fixtureRegistry = { "full-reader": fixturePath };
const defaultImports = `import { DecisionText as Reader } from "./case-viewer/decision-text";
import { useDecisionProvisionAnchors as load } from "./case-viewer/use-decision-provision-anchors";
import { visibleDecisionBlocks as visible } from "./case-viewer/decision-text.logic";`;
const fixture = (body: string, imports = defaultImports) => [
  { file: fixturePath, text: `${imports}\nconst View = () => { ${body} };` },
];
const readerProps =
  'surface="full-reader" provisionAnchors={anchors} decisionId={decisionId} decision={decision}';
const loaderInput =
  'surface: "full-reader", decisionId, blocks: visible(ast, kind, decision.fulltext)';

test("decision reader census accepts aliases with matching decision text inputs", () => {
  expect(
    inspectReaderSurfaces(
      fixture(
        `const anchors = load({ ${loaderInput} }); return <Reader ${readerProps} />;`,
      ),
      fixtureRegistry,
    ),
  ).toEqual([]);
  expect(
    inspectReaderSurfaces(
      fixture(
        `const anchors = Hooks.useDecisionProvisionAnchors({ surface: "full-reader", decisionId, blocks: Text.visibleDecisionBlocks(ast, kind, decision?.fulltext) }); return <Readers.DecisionText ${readerProps} />;`,
        'import * as Readers from "./case-viewer/decision-text"; import * as Hooks from "./case-viewer/use-decision-provision-anchors"; import * as Text from "./case-viewer/decision-text.logic";',
      ),
      fixtureRegistry,
    ),
  ).toEqual([]);
  expect(
    inspectReaderSurfaces(
      fixture(
        `const Alias = Reader; const anchors = load({ ${loaderInput} }); return <Alias ${readerProps} />;`,
      ),
      fixtureRegistry,
    ),
  ).toEqual([]);
});

test("decision reader census rejects every loader and surface bypass", () => {
  const wrongInputs = [
    "{}",
    `{ ${loaderInput.replace("decisionId,", "decisionId: otherId,")} }`,
    `{ ${loaderInput.replace('"full-reader"', '"inspector"')} }`,
    '{ surface: "full-reader", decisionId, blocks: [] }',
    '{ surface: "full-reader", decisionId, blocks: visible(ast, kind) }',
    '{ surface: "full-reader", decisionId, blocks: visible(ast, kind, other.fulltext) }',
    '{ surface: "full-reader", decisionId, blocks: visible(ast, kind, decision.fulltext), ...overrides }',
  ];
  for (const input of wrongInputs) {
    expect(
      inspectReaderSurfaces(
        fixture(
          `const anchors = load(${input}); return <Reader ${readerProps} />;`,
        ),
        fixtureRegistry,
      ).length,
    ).toBeGreaterThan(0);
  }
  for (const props of [
    readerProps.replace('surface="full-reader"', ""),
    readerProps.replace('surface="full-reader"', 'surface="inspector"'),
    readerProps.replace('surface="full-reader"', 'surface={"full-reader"}'),
    readerProps.replace("provisionAnchors={anchors}", ""),
    readerProps.replace("decisionId={decisionId}", "decisionId={otherId}"),
    readerProps.replace("decision={decision}", "decision={other}"),
    `${readerProps} {...overrides}`,
  ]) {
    expect(
      inspectReaderSurfaces(
        fixture(
          `const anchors = load({ ${loaderInput} }); return <Reader ${props} />;`,
        ),
        fixtureRegistry,
      ).length,
    ).toBeGreaterThan(0);
  }
  for (const body of [
    `const anchors = []; return <Reader ${readerProps} />;`,
    `const unrelated = () => { const anchors = load({ ${loaderInput} }); }; const anchors = []; return <Reader ${readerProps} />;`,
  ]) {
    expect(
      inspectReaderSurfaces(fixture(body), fixtureRegistry).length,
    ).toBeGreaterThan(0);
  }
  expect(
    inspectReaderSurfaces(
      fixture(
        `const anchors = load({ ${loaderInput} }); return <Reader ${readerProps} />;`,
      ),
      {},
    ).length,
  ).toBeGreaterThan(0);
  expect(inspectReaderSurfaces([], fixtureRegistry)).toEqual([
    `${fixturePath}: registered reader has no DecisionText consumer`,
  ]);
});

test("only a registered development route may omit stored-row loading", () => {
  expect(
    inspectReaderSurfaces(fixture('return <Reader surface="development" />;'), {
      development: fixturePath,
    }),
  ).toContain(`${fixturePath}: development exemption outside routes/dev`);
  const developmentPath = "apps/web/src/routes/dev/reader.tsx";
  expect(
    inspectReaderSurfaces(
      fixture('return <Reader surface="development" />;').map((source) => ({
        ...source,
        file: developmentPath,
      })),
      { development: developmentPath },
    ),
  ).toEqual([]);
});

test("every real decision text reader declares its registered surface and stored-row loading", () => {
  const root = path.resolve(import.meta.dir, "..");
  const files = Array.from(
    new Bun.Glob("apps/web/src/**/*.{ts,tsx}").scanSync({ cwd: root }),
  ).toSorted();
  const sources = files.map((sourcePath) => ({
    file: sourcePath,
    text: readFileSync(path.join(root, sourcePath), "utf-8"),
  }));
  expect(inspectReaderSurfaces(sources, DECISION_READER_SURFACES)).toEqual([]);
});
