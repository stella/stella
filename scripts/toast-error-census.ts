import path from "node:path";

import {
  type Node,
  type ObjectProperty,
  type ParsedSource,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

type Identifier = Extract<Node, { type: "Identifier" }>;
type FunctionLike = Extract<
  Node,
  {
    type:
      "ArrowFunctionExpression" | "FunctionDeclaration" | "FunctionExpression";
  }
>;

const TRUNCATING_CLASS =
  /(?:^|[\s:])(?:truncate|text-ellipsis|line-clamp-\d+|whitespace-nowrap|overflow-hidden)(?:\s|$)/u;
const ERROR_CAPABLE_METHODS = new Set(["error", "add", "update", "promise"]);

const textFields = new Set(["title", "description"]);
type SourceTree = ParsedSource & { parents: ReadonlyMap<Node, Node> };
const nodeText = (node: Node, source: ParsedSource) =>
  source.sourceText.slice(node.start, node.end);
const isFunctionLike = (node: Node): node is FunctionLike =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression";
const stringValue = (node: Node) => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked;
  }
  return undefined;
};
const visitChildren = (root: Node, visit: (node: Node) => void) => {
  walk(root, (node) => {
    if (node !== root) {
      visit(node);
      return "skip-children";
    }
    return undefined;
  });
};

type SourceBinding = { value: Node; scope: Node };
const bindingAtScope = (bindings: readonly SourceBinding[], scope: Node) =>
  bindings.findLast((candidate) => candidate.scope === scope);

const collectToastBindings = (source: SourceTree) => {
  const toastNames = new Set<string>();
  const errorWrappers = new Set<string>();
  const declarations = new Map<string, SourceBinding[]>();
  const declare = (name: string, value: Node, declaration: Node) => {
    let scope = source.parents.get(declaration);
    while (
      scope &&
      scope.type !== "BlockStatement" &&
      scope.type !== "Program"
    ) {
      scope = source.parents.get(scope);
    }
    if (!scope) {
      return;
    }
    const bindings = declarations.get(name) ?? [];
    bindings.push({ value, scope });
    declarations.set(name, bindings);
  };
  const resolve = (identifier: Identifier) => {
    const bindings = declarations.get(identifier.name) ?? [];
    let scope = source.parents.get(identifier);
    while (scope) {
      const binding = bindingAtScope(bindings, scope);
      if (binding) {
        return binding.value;
      }
      if (
        isFunctionLike(scope) &&
        scope.params.some(
          (parameter) =>
            parameter.type === "Identifier" &&
            parameter.name === identifier.name,
        )
      ) {
        return undefined;
      }
      scope = source.parents.get(scope);
    }
    return undefined;
  };
  const collect = (node: Node) => {
    if (node.type === "ImportDeclaration") {
      for (const binding of node.specifiers) {
        if (binding.type !== "ImportSpecifier") {
          continue;
        }
        const imported =
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value;
        if (
          /@stll\/ui(?:\/components)?\/toast$/u.test(node.source.value) &&
          imported === "stellaToast"
        ) {
          toastNames.add(binding.local.name);
        }
        if (
          /(?:^|\/)user-toast$/u.test(node.source.value) &&
          [
            "notifyUserError",
            "notifyAuthClientError",
            "detachedUserAction",
          ].includes(imported)
        ) {
          errorWrappers.add(binding.local.name);
        }
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init
    ) {
      declare(node.id.name, node.init, node);
    }
    if (node.type === "FunctionDeclaration" && node.id && node.body) {
      declare(node.id.name, node.body, node);
    }
    visitChildren(node, collect);
  };
  collect(source.program);

  return { toastNames, errorWrappers, resolve };
};

const returnedExpressions = (body: Node | null) => {
  if (body === null) {
    return [];
  }
  const expressions: Node[] = [];
  const visit = (node: Node) => {
    if (node.type === "ReturnStatement") {
      if (node.argument) {
        expressions.push(node.argument);
      }
      return;
    }
    if (isFunctionLike(node)) {
      return;
    }
    visitChildren(node, visit);
  };
  if (body.type === "BlockStatement") {
    visit(body);
  } else {
    expressions.push(body);
  }
  return expressions;
};

const createRenderedFields =
  (
    source: SourceTree,
    resolve: ReturnType<typeof collectToastBindings>["resolve"],
  ) =>
  (root: Node | undefined, fields: ReadonlySet<string>) => {
    const values: Node[] = [];
    const seen = new Set<Node>();
    const visit = (node: Node) => {
      if (seen.has(node)) {
        return;
      }
      seen.add(node);
      if (node.type === "Identifier") {
        const declaration = resolve(node);
        if (declaration) {
          visit(declaration);
        }
        return;
      }
      if (
        node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression" ||
        node.type === "ParenthesizedExpression"
      ) {
        visit(node.expression);
        return;
      }
      if (node.type === "ConditionalExpression") {
        visit(node.consequent);
        visit(node.alternate);
        return;
      }
      if (
        node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression"
      ) {
        for (const expression of returnedExpressions(node.body)) {
          visit(expression);
        }
        return;
      }
      if (node.type === "CallExpression" && node.callee.type === "Identifier") {
        const declaration = resolve(node.callee);
        if (declaration) {
          visit(declaration);
        }
        return;
      }
      if (node.type === "BlockStatement") {
        for (const expression of returnedExpressions(node)) {
          visit(expression);
        }
        return;
      }
      if (!(node.type === "ObjectExpression")) {
        return;
      }
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          visit(property.argument);
        } else if (
          !property.method &&
          !property.shorthand &&
          property.kind === "init" &&
          fields.has(nodeText(property.key, source).replaceAll(/['"]/gu, ""))
        ) {
          values.push(property.value);
        } else if (
          property.shorthand &&
          fields.has(
            property.key.type === "Identifier" ? property.key.name : "",
          )
        ) {
          values.push(property.value);
        }
      }
    };
    if (root) {
      visit(root);
    }
    return values;
  };

const createOptionText =
  (renderedFields: ReturnType<typeof createRenderedFields>) =>
  (node: Node | undefined) => [
    ...renderedFields(node, textFields),
    ...renderedFields(node, new Set(["action", "actionProps"])).flatMap(
      (action) => renderedFields(action, new Set(["label", "children"])),
    ),
  ];

const createTruncatingAttribute =
  (
    source: SourceTree,
    resolve: ReturnType<typeof collectToastBindings>["resolve"],
  ) =>
  (node: Node) => {
    if (!(node.type === "JSXAttribute") || !node.value) {
      return false;
    }
    if (nodeText(node.name, source) === "style") {
      return /\b(?:textOverflow\s*:\s*["']ellipsis|WebkitLineClamp\s*:|whiteSpace\s*:\s*["']nowrap)/u.test(
        nodeText(node.value, source),
      );
    }
    if (nodeText(node.name, source) !== "className") {
      return false;
    }
    const seen = new Set<Node>();
    let found = false;
    const visit = (value: Node) => {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      if (
        stringValue(value) !== undefined &&
        TRUNCATING_CLASS.test(stringValue(value) ?? "")
      ) {
        found = true;
      }
      if (value.type === "Identifier") {
        const declaration = resolve(value);
        if (declaration) {
          visit(declaration);
        }
      }
      visitChildren(value, visit);
    };
    visit(node.value);
    return found;
  };

const isPropertyName = (node: Node, parent: Node | undefined) =>
  (parent?.type === "MemberExpression" &&
    !parent.computed &&
    parent.property === node) ||
  (parent?.type === "Property" && !parent.shorthand && parent.key === node) ||
  (parent?.type === "JSXAttribute" && parent.name === node);

type ToastTruncationDetectorOptions = {
  source: SourceTree;
  resolve: ReturnType<typeof collectToastBindings>["resolve"];
  renderedFields: ReturnType<typeof createRenderedFields>;
  optionText: ReturnType<typeof createOptionText>;
};
const createToastTruncationDetector = ({
  source,
  resolve,
  renderedFields,
  optionText,
}: ToastTruncationDetectorOptions) => {
  const attributeTruncates = createTruncatingAttribute(source, resolve);
  return (root: Node) => {
    const seen = new Set<Node>();
    let found = false;
    const visit = (node: Node) => {
      if (seen.has(node)) {
        return;
      }
      seen.add(node);
      // Data receivers and request arguments are not rendered toast content.
      // Following them can reach a route's entire page through its loader.
      if (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier"
      ) {
        if (node.object.type === "Identifier") {
          const declaration = resolve(node.object);
          for (const renderedText of renderedFields(
            declaration,
            new Set([node.property.name]),
          )) {
            visit(renderedText);
          }
        }
        return;
      }
      if (node.type === "MemberExpression" && node.computed) {
        return;
      }
      if (node.type === "CallExpression") {
        if (node.callee.type === "Identifier") {
          const declaration = resolve(node.callee);
          if (declaration) {
            visit(declaration);
          }
        }
        for (const argument of node.arguments) {
          if (
            argument.type === "JSXElement" ||
            argument.type === "JSXFragment"
          ) {
            visit(argument);
          }
        }
        return;
      }
      if (
        node.type === "ArrowFunctionExpression" ||
        node.type === "FunctionExpression"
      ) {
        for (const expression of returnedExpressions(node.body)) {
          visit(expression);
        }
        return;
      }
      if (node.type === "BlockStatement") {
        for (const expression of returnedExpressions(node)) {
          visit(expression);
        }
        return;
      }
      if (node.type === "ObjectExpression") {
        for (const renderedText of optionText(node)) {
          visit(renderedText);
        }
        return;
      }
      const parent = source.parents.get(node);
      if (node.type === "Identifier" && !isPropertyName(node, parent)) {
        const declaration = resolve(node);
        if (declaration) {
          visit(declaration);
        }
      }
      if (attributeTruncates(node)) {
        found = true;
      }
      visitChildren(node, visit);
    };
    visit(root);
    return found;
  };
};

export const inspectToastSource = (text: string, fileName = "source.tsx") => {
  const parsed = parseSource(fileName, text);
  const parents = new Map<Node, Node>();
  walk(parsed.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent) {
      parents.set(node, parent);
    }
  });
  const source = { ...parsed, parents };
  const { toastNames, errorWrappers, resolve } = collectToastBindings(source);
  const renderedFields = createRenderedFields(source, resolve);
  const optionText = createOptionText(renderedFields);
  const truncates = createToastTruncationDetector({
    source,
    resolve,
    renderedFields,
    optionText,
  });
  const entries: { line: number; kind: string; truncating: boolean }[] = [];
  const record = (node: Node, kind: string, texts: readonly Node[]) => {
    entries.push({
      line: source.locate(node.start).line,
      kind,
      truncating: texts.some(truncates),
    });
  };
  const inspect = (node: Node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      node.callee.object.type === "Identifier" &&
      toastNames.has(node.callee.object.name) &&
      ERROR_CAPABLE_METHODS.has(node.callee.property.name)
    ) {
      const method = node.callee.property.name;
      const argument =
        method === "update" || method === "promise"
          ? node.arguments.at(1)
          : node.arguments.at(0);
      let texts = optionText(argument);
      if (method === "error") {
        texts = [
          ...(argument ? [argument] : []),
          ...optionText(node.arguments.at(1)),
        ];
      }
      if (method === "promise") {
        texts = renderedFields(argument, new Set(["error"]));
      }
      record(node, method, texts);
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      errorWrappers.has(node.callee.name)
    ) {
      const fallback = node.arguments.at(1);
      const texts = fallback ? [fallback] : [];
      record(node, "error-wrapper", [
        ...texts,
        ...optionText(node.arguments.at(2)),
        ...renderedFields(fallback, new Set(["failureMessage"])),
      ]);
    }
    // Exported option builders may be consumed in another file. Their error
    // variant is part of the same census even without a local toast call.
    if (node.type === "ObjectExpression") {
      const properties = node.properties.filter(
        (property): property is ObjectProperty =>
          property.type === "Property" &&
          !property.method &&
          !property.shorthand &&
          property.kind === "init",
      );
      const hasErrorType = properties.some(
        (property) =>
          nodeText(property.key, source).replaceAll(/['"]/gu, "") === "type" &&
          property.value.type === "Literal" &&
          property.value.value === "error",
      );
      const hasText = node.properties.some(
        (property) =>
          ((property.type === "Property" &&
            !property.method &&
            !property.shorthand &&
            property.kind === "init") ||
            (property.type === "Property" && property.shorthand)) &&
          textFields.has(
            nodeText(property.key, source).replaceAll(/['"]/gu, ""),
          ),
      );
      if (hasErrorType && hasText) {
        record(node, "error-options", optionText(node));
      }
    }
    visitChildren(node, inspect);
  };
  inspect(source.program);
  return entries;
};

const censusToastErrors = async (root: string) => {
  const entries: {
    file: string;
    line: number;
    kind: string;
    truncating: boolean;
  }[] = [];
  for (const pattern of [
    "apps/**/src/**/*.{ts,tsx}",
    "packages/**/src/**/*.{ts,tsx}",
  ]) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: root })) {
      if (
        /\.(?:test|spec|fixture)\./u.test(file) ||
        file.includes("node_modules/")
      ) {
        continue;
      }
      const text = await Bun.file(path.join(root, file)).text();
      if (!/toast|Toast/u.test(text)) {
        continue;
      }
      for (const entry of inspectToastSource(text, file)) {
        entries.push({ file, ...entry });
      }
    }
  }
  return entries;
};

if (import.meta.main) {
  const entries = await censusToastErrors(path.resolve(import.meta.dir, ".."));
  const failures = entries.filter(({ truncating }) => truncating);
  for (const { file, line, kind } of failures) {
    console.error(
      `${file}:${line}: ${kind} error toast truncates its text; render the full reason.`,
    );
  }
  console.log(
    `Enumerated ${entries.length} error-capable toast callsites and option variants.`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}
