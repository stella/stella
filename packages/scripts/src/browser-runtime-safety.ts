import ts from "typescript";

const isFunctionScope = (node: ts.Node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

const hasTemplateBinding = (access: ts.PropertyAccessExpression) => {
  const receiver = access.expression;
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  let scope: ts.Node = access;
  while (!isFunctionScope(scope) && !ts.isSourceFile(scope)) {
    scope = scope.parent;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (node !== scope && isFunctionScope(node)) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === receiver.text &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const call = node.initializer;
      const tag = call.arguments.at(0);
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "createElement" &&
        tag &&
        ts.isStringLiteral(tag) &&
        tag.text === "template"
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
};

export const inspectBrowserRuntimeSafety = (source: string) => {
  const ast = ts.createSourceFile(
    "runtime.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const problems: string[] = [];
  let templateWrites = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      (node.text === "eval" || node.text === "Function")
    ) {
      problems.push("dynamic code");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      ["eval", "Function", "innerHTML"].includes(node.argumentExpression.text)
    ) {
      problems.push("computed code or markup sink");
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "innerHTML") {
      if (!hasTemplateBinding(node)) {
        problems.push("markup outside template parsing");
      }
      templateWrites++;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { problems, templateWrites };
};
