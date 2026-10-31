import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DECISION_READER_SURFACES } from "../apps/web/src/features/case-law/decision-reader-surfaces";
import {
  type CallExpression,
  type JSXOpeningElement,
  type Node,
  type ObjectExpression,
  parseSource,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";

type ReaderRegistry = Readonly<Record<string, readonly string[]>>;
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
type ReaderElement = JSXOpeningElement;
const scopes = new WeakMap<Node, Node>();
const texts = new WeakMap<Node, string>();
const functionScope = (node: Node): Node => scopes.get(node) ?? node;
const collectNodes = (source: Program, text: string): Node[] => {
  const nodes: Node[] = [];
  walk(source, (node, ancestors) => {
    nodes.push(node);
    texts.set(node, text.slice(node.start, node.end));
    const scope = ancestors.findLast((ancestor) =>
      [
        "Program",
        "ArrowFunctionExpression",
        "FunctionExpression",
        "FunctionDeclaration",
      ].includes(ancestor.type),
    );
    if (scope) {
      scopes.set(node, scope);
    }
  });
  return nodes;
};

const importedSymbols = (member: string): ImportedSymbols => ({
  names: new Set(),
  namespaces: new Set(),
  member,
});

const namedExpression = (
  expression: Node,
  symbols: ImportedSymbols,
): boolean =>
  expression.type === "Identifier" || expression.type === "JSXIdentifier"
    ? symbols.names.has(expression.name)
    : ((expression.type === "MemberExpression" && !expression.computed) ||
        expression.type === "JSXMemberExpression") &&
      (expression.object.type === "Identifier" ||
        expression.object.type === "JSXIdentifier") &&
      symbols.namespaces.has(expression.object.name) &&
      (expression.property.type === "Identifier" ||
        expression.property.type === "JSXIdentifier") &&
      expression.property.name === symbols.member;

const readImports = (nodes: readonly Node[]): ReaderImports => {
  const imports = {
    reader: importedSymbols("WebDecisionReader"),
    hook: importedSymbols("useDecisionProvisionAnchors"),
    blocks: importedSymbols("visibleDecisionBlocks"),
  };
  const modules = [
    { suffix: "/web-decision-reader", symbols: imports.reader },
    { suffix: "/use-decision-provision-anchors", symbols: imports.hook },
    { suffix: "/case-law-reader", symbols: imports.blocks },
  ];
  for (const node of nodes) {
    if (node.type !== "ImportDeclaration") {
      continue;
    }
    const moduleName = node.source.value.replace(/\.[cm]?[jt]sx?$/u, "");
    const symbols = modules.find(({ suffix }) =>
      moduleName.endsWith(suffix),
    )?.symbols;
    if (!symbols) {
      continue;
    }
    for (const binding of node.specifiers) {
      if (binding.type === "ImportNamespaceSpecifier") {
        symbols.namespaces.add(binding.local.name);
      }
      if (
        binding.type === "ImportSpecifier" &&
        (binding.imported.type === "Identifier"
          ? binding.imported.name
          : binding.imported.value) === symbols.member
      ) {
        symbols.names.add(binding.local.name);
      }
    }
  }
  return imports;
};

const includeReaderAliases = (
  nodes: readonly Node[],
  reader: ImportedSymbols,
) => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (
        node.type !== "VariableDeclarator" ||
        node.id.type !== "Identifier" ||
        !node.init
      ) {
        continue;
      }
      if (
        namedExpression(node.init, reader) &&
        !reader.names.has(node.id.name)
      ) {
        reader.names.add(node.id.name);
        changed = true;
      }
    }
  }
};

const readBindings = (nodes: readonly Node[]) => {
  const byScope = new Map<Node, Map<string, Node | undefined>>();
  for (const node of nodes) {
    if (node.type !== "VariableDeclarator") {
      continue;
    }
    const scope = functionScope(node);
    let bindings = byScope.get(scope);
    if (!bindings) {
      bindings = new Map();
      byScope.set(scope, bindings);
    }
    if (node.id.type === "Identifier") {
      bindings.set(node.id.name, node.init ?? undefined);
      continue;
    }
    if (node.id.type !== "ObjectPattern") {
      continue;
    }
    for (const element of node.id.properties) {
      if (
        element.type !== "Property" ||
        element.value.type !== "Identifier" ||
        !(
          (element.key.type === "Identifier" &&
            element.key.name === "anchors") ||
          (element.key.type === "Literal" && element.key.value === "anchors")
        )
      ) {
        continue;
      }
      bindings.set(element.value.name, node.init ?? undefined);
    }
  }
  return byScope;
};

const jsxAttribute = (node: ReaderElement, name: string): Node | undefined => {
  for (const attribute of node.attributes) {
    if (
      attribute.type === "JSXAttribute" &&
      attribute.name.type === "JSXIdentifier" &&
      attribute.name.name === name
    ) {
      return attribute.value ?? undefined;
    }
  }
  return undefined;
};
const jsxExpression = (node: ReaderElement, name: string): Node | undefined => {
  const attribute = jsxAttribute(node, name);
  return attribute?.type === "JSXExpressionContainer"
    ? attribute.expression
    : undefined;
};
const objectProperty = (
  object: ObjectExpression,
  name: string,
): Node | undefined => {
  for (const property of object.properties) {
    if (
      property.type === "Property" &&
      !property.computed &&
      !property.method &&
      property.kind === "init" &&
      ((property.key.type === "Identifier" && property.key.name === name) ||
        (property.key.type === "Literal" && property.key.value === name))
    ) {
      return property.value;
    }
  }
  return undefined;
};

const sameExpression = (
  left: Node | undefined,
  right: Node | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  texts.get(left) === texts.get(right);

type HookContractOptions = {
  node: ReaderElement;
  hookCall: CallExpression;
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
    input.type !== "ObjectExpression" ||
    input.properties.some((property) => property.type === "SpreadElement")
  ) {
    return ["provision loader must declare its reader inputs explicitly"];
  }
  const findings: string[] = [];
  const surface = objectProperty(input, "surface");
  if (!surface || surface.type !== "Literal" || surface.value !== expected) {
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
    blocks.type !== "CallExpression" ||
    !namedExpression(blocks.callee, imports.blocks)
  ) {
    findings.push(
      "provision loader blocks must come from visibleDecisionBlocks",
    );
    return findings;
  }
  const argument = blocks.arguments.at(2);
  const fulltext =
    argument?.type === "ChainExpression" ? argument.expression : argument;
  if (
    !fulltext ||
    fulltext.type !== "MemberExpression" ||
    fulltext.computed ||
    fulltext.property.type !== "Identifier" ||
    fulltext.property.name !== "fulltext" ||
    !sameExpression(fulltext.object, jsxExpression(node, "decision"))
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
  if (
    node.attributes.some((attribute) => attribute.type === "JSXSpreadAttribute")
  ) {
    findings.push("spread props cannot override registered reader contracts");
  }
  const surface = jsxAttribute(node, "surface");
  if (!surface || surface.type !== "Literal" || surface.value !== expected) {
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
    provision?.type === "Identifier"
      ? bindings.get(functionScope(node))?.get(provision.name)
      : undefined;
  if (
    !hookCall ||
    hookCall.type !== "CallExpression" ||
    !namedExpression(hookCall.callee, imports.hook)
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
  const source = parseSource(file, text).program;
  const nodes = collectNodes(source, text);
  const imports = readImports(nodes);
  includeReaderAliases(nodes, imports.reader);
  const bindings = readBindings(nodes);
  const expected = Object.entries(registry).find(([, registered]) =>
    registered.includes(file),
  )?.[0];
  const findings: string[] = [];
  let consumerCount = 0;
  for (const node of nodes) {
    if (
      node.type !== "JSXOpeningElement" ||
      !namedExpression(node.name, imports.reader)
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
  for (const registeredPath of Object.values(registry).flat()) {
    if (!seen.has(registeredPath)) {
      findings.push(
        `${registeredPath}: registered reader has no DecisionText consumer`,
      );
    }
  }
  return findings;
};

const fixturePath = "apps/web/src/features/case-law/reader.tsx";
const fixtureRegistry = { "full-reader": [fixturePath] };
const defaultImports = `import { WebDecisionReader as Reader } from "./web-decision-reader";
import { useDecisionProvisionAnchors as load } from "./case-viewer/use-decision-provision-anchors";
import { visibleDecisionBlocks as visible } from "@stll/legal-ast/case-law-reader";`;
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
        `const anchors = Hooks.useDecisionProvisionAnchors({ surface: "full-reader", decisionId, blocks: Text.visibleDecisionBlocks(ast, kind, decision?.fulltext) }); return <Readers.WebDecisionReader ${readerProps} />;`,
        'import * as Readers from "./web-decision-reader"; import * as Hooks from "./case-viewer/use-decision-provision-anchors"; import * as Text from "@stll/legal-ast/case-law-reader";',
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

test("decision reader census tracks destructured anchor results without accepting other hook fields", () => {
  for (const binding of ["{ anchors }", "{ anchors: renamed }"]) {
    expect(
      inspectReaderSurfaces(
        fixture(
          `const ${binding} = load({ ${loaderInput} }); return <Reader ${readerProps.replace("{anchors}", () => (binding.includes("renamed") ? "{renamed}" : "{anchors}"))} />;`,
        ),
        fixtureRegistry,
      ),
    ).toEqual([]);
  }
  for (const binding of [
    "{ externalAnchors: anchors }",
    "{ ...anchors }",
    "{ anchors = [] }",
  ]) {
    expect(
      inspectReaderSurfaces(
        fixture(
          `const ${binding} = load({ ${loaderInput} }); return <Reader ${readerProps} />;`,
        ),
        fixtureRegistry,
      ),
    ).toEqual([
      `${fixturePath}: provisionAnchors must receive this reader's useDecisionProvisionAnchors result`,
    ]);
  }
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
      development: [fixturePath],
    }),
  ).toContain(`${fixturePath}: development exemption outside routes/dev`);
  const developmentPath = "apps/web/src/routes/dev/reader.tsx";
  expect(
    inspectReaderSurfaces(
      fixture('return <Reader surface="development" />;').map((source) => ({
        ...source,
        file: developmentPath,
      })),
      { development: [developmentPath] },
    ),
  ).toEqual([]);
});

test("a shared development surface enumerates every consumer in both directions", () => {
  const paths = [
    "apps/web/src/routes/dev/first.tsx",
    "apps/web/src/routes/dev/second.tsx",
  ];
  const sources = paths.map((file) => ({
    file,
    text: `${defaultImports}\nconst View = () => <Reader surface="development" />;`,
  }));
  expect(inspectReaderSurfaces(sources, { development: paths })).toEqual([]);
  for (const omitted of paths) {
    expect(
      inspectReaderSurfaces(
        sources.filter(({ file }) => file !== omitted),
        { development: paths },
      ),
    ).toEqual([`${omitted}: registered reader has no DecisionText consumer`]);
    expect(
      inspectReaderSurfaces(sources, {
        development: paths.filter((file) => file !== omitted),
      }),
    ).toEqual([`${omitted}: unregistered DecisionText consumer`]);
  }
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
