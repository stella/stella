import path from "node:path";
import ts from "typescript";

import { parseSource } from "./parse-memo";

const TRUNCATING_CLASS =
  /(?:^|[\s:])(?:truncate|text-ellipsis|line-clamp-\d+|whitespace-nowrap|overflow-hidden)(?:\s|$)/u;
const ERROR_CAPABLE_METHODS = new Set(["error", "add", "update", "promise"]);

const textFields = new Set(["title", "description"]);

type SourceBinding = { value: ts.Node; scope: ts.Node };
const bindingAtScope = (bindings: readonly SourceBinding[], scope: ts.Node) =>
  bindings.findLast((candidate) => candidate.scope === scope);

const collectToastBindings = (source: ts.SourceFile) => {
  const toastNames = new Set<string>();
  const errorWrappers = new Set<string>();
  const declarations = new Map<string, SourceBinding[]>();
  const declare = (name: string, value: ts.Node, declaration: ts.Node) => {
    let scope = declaration.parent;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) {
      scope = scope.parent;
    }
    const bindings = declarations.get(name) ?? [];
    bindings.push({ value, scope });
    declarations.set(name, bindings);
  };
  const resolve = (identifier: ts.Identifier) => {
    const bindings = declarations.get(identifier.text) ?? [];
    let scope: ts.Node | undefined = identifier.parent;
    while (scope) {
      const binding = bindingAtScope(bindings, scope);
      if (binding) {
        return binding.value;
      }
      if (
        ts.isFunctionLike(scope) &&
        scope.parameters.some(
          (parameter) =>
            ts.isIdentifier(parameter.name) &&
            parameter.name.text === identifier.text,
        )
      ) {
        return undefined;
      }
      scope = scope.parent;
    }
    return undefined;
  };
  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /@stll\/ui(?:\/components)?\/toast$/u.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === "stellaToast") {
            toastNames.add(binding.name.text);
          }
        }
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /(?:^|\/)user-toast$/u.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (
            [
              "notifyUserError",
              "notifyAuthClientError",
              "detachedUserAction",
            ].includes((binding.propertyName ?? binding.name).text)
          ) {
            errorWrappers.add(binding.name.text);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declare(node.name.text, node.initializer, node);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      declare(node.name.text, node.body, node);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  return { toastNames, errorWrappers, resolve };
};

const returnedExpressions = (body: ts.Node) => {
  const expressions: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) {
        expressions.push(node.expression);
      }
      return;
    }
    if (ts.isFunctionLike(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  if (ts.isBlock(body)) {
    visit(body);
  } else {
    expressions.push(body);
  }
  return expressions;
};

const createRenderedFields =
  (
    source: ts.SourceFile,
    resolve: ReturnType<typeof collectToastBindings>["resolve"],
  ) =>
  (root: ts.Node | undefined, fields: ReadonlySet<string>) => {
    const values: ts.Node[] = [];
    const seen = new Set<ts.Node>();
    const visit = (node: ts.Node) => {
      if (seen.has(node)) {
        return;
      }
      seen.add(node);
      if (ts.isIdentifier(node)) {
        const declaration = resolve(node);
        if (declaration) {
          visit(declaration);
        }
        return;
      }
      if (
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isParenthesizedExpression(node)
      ) {
        visit(node.expression);
        return;
      }
      if (ts.isConditionalExpression(node)) {
        visit(node.whenTrue);
        visit(node.whenFalse);
        return;
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        for (const expression of returnedExpressions(node.body)) {
          visit(expression);
        }
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const declaration = resolve(node.expression);
        if (declaration) {
          visit(declaration);
        }
        return;
      }
      if (ts.isBlock(node)) {
        for (const expression of returnedExpressions(node)) {
          visit(expression);
        }
        return;
      }
      if (!ts.isObjectLiteralExpression(node)) {
        return;
      }
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          visit(property.expression);
        } else if (
          ts.isPropertyAssignment(property) &&
          fields.has(property.name.getText(source).replaceAll(/['"]/gu, ""))
        ) {
          values.push(property.initializer);
        } else if (
          ts.isShorthandPropertyAssignment(property) &&
          fields.has(property.name.text)
        ) {
          values.push(property.name);
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
  (node: ts.Node | undefined) => [
    ...renderedFields(node, textFields),
    ...renderedFields(node, new Set(["action", "actionProps"])).flatMap(
      (action) => renderedFields(action, new Set(["label", "children"])),
    ),
  ];

const createTruncatingAttribute =
  (
    source: ts.SourceFile,
    resolve: ReturnType<typeof collectToastBindings>["resolve"],
  ) =>
  (node: ts.Node) => {
    if (!ts.isJsxAttribute(node) || !node.initializer) {
      return false;
    }
    if (node.name.getText(source) === "style") {
      return /\b(?:textOverflow\s*:\s*["']ellipsis|WebkitLineClamp\s*:|whiteSpace\s*:\s*["']nowrap)/u.test(
        node.initializer.getText(source),
      );
    }
    if (node.name.getText(source) !== "className") {
      return false;
    }
    const seen = new Set<ts.Node>();
    let found = false;
    const visit = (value: ts.Node) => {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      if (ts.isStringLiteralLike(value) && TRUNCATING_CLASS.test(value.text)) {
        found = true;
      }
      if (ts.isIdentifier(value)) {
        const declaration = resolve(value);
        if (declaration) {
          visit(declaration);
        }
      }
      ts.forEachChild(value, visit);
    };
    visit(node.initializer);
    return found;
  };

type ToastTruncationDetectorOptions = {
  source: ts.SourceFile;
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
  return (root: ts.Node) => {
    const seen = new Set<ts.Node>();
    let found = false;
    const visit = (node: ts.Node) => {
      if (seen.has(node)) {
        return;
      }
      seen.add(node);
      // Data receivers and request arguments are not rendered toast content.
      // Following them can reach a route's entire page through its loader.
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const declaration = resolve(node.expression);
          for (const renderedText of renderedFields(
            declaration,
            new Set([node.name.text]),
          )) {
            visit(renderedText);
          }
        }
        return;
      }
      if (ts.isElementAccessExpression(node)) {
        return;
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const declaration = resolve(node.expression);
          if (declaration) {
            visit(declaration);
          }
        }
        for (const argument of node.arguments) {
          if (
            ts.isJsxElement(argument) ||
            ts.isJsxSelfClosingElement(argument) ||
            ts.isJsxFragment(argument)
          ) {
            visit(argument);
          }
        }
        return;
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        for (const expression of returnedExpressions(node.body)) {
          visit(expression);
        }
        return;
      }
      if (ts.isBlock(node)) {
        for (const expression of returnedExpressions(node)) {
          visit(expression);
        }
        return;
      }
      if (ts.isObjectLiteralExpression(node)) {
        for (const renderedText of optionText(node)) {
          visit(renderedText);
        }
        return;
      }
      if (
        ts.isIdentifier(node) &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !(ts.isJsxAttribute(node.parent) && node.parent.name === node)
      ) {
        const declaration = resolve(node);
        if (declaration) {
          visit(declaration);
        }
      }
      if (attributeTruncates(node)) {
        found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  };
};

export const inspectToastSource = (text: string, fileName = "source.tsx") => {
  const source = parseSource({ text, fileName });
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
  const record = (node: ts.Node, kind: string, texts: readonly ts.Node[]) => {
    entries.push({
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
      truncating: texts.some(truncates),
    });
  };
  const inspect = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      toastNames.has(node.expression.expression.text) &&
      ERROR_CAPABLE_METHODS.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
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
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      errorWrappers.has(node.expression.text)
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
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const hasErrorType = properties.some(
        (property) =>
          property.name.getText(source).replaceAll(/['"]/gu, "") === "type" &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === "error",
      );
      const hasText = node.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          textFields.has(
            property.name.getText(source).replaceAll(/['"]/gu, ""),
          ),
      );
      if (hasErrorType && hasText) {
        record(node, "error-options", optionText(node));
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
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
