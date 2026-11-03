import { panic } from "better-result";
import path from "node:path";
import * as ts from "tsrs/unstable/ast";
import { API, type Checker } from "tsrs/unstable/async";
import { serverFS } from "tsrs/unstable/fs";

const hasTemplateBinding = async (
  access: ts.PropertyAccessExpression,
  checker: Checker,
) => {
  const receiver = access.expression;
  if (!ts.isIdentifier(receiver)) {
    return false;
  }
  const symbol = await checker.getSymbolAtLocation(receiver);
  const declaration = await symbol?.valueDeclaration?.resolve();
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !ts.isCallExpression(declaration.initializer)
  ) {
    return false;
  }
  const call = declaration.initializer;
  const tag = call.arguments.at(0);
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "createElement" &&
    tag !== undefined &&
    ts.isStringLiteral(tag) &&
    tag.text === "template"
  );
};

export const inspectBrowserRuntimeSafety = async (source: string) => {
  const filename = path.resolve("runtime.js");
  const config = path.resolve("tsconfig.__browser-runtime__.json");
  const configText = JSON.stringify({
    files: [filename],
    compilerOptions: { allowJs: true, noLib: true, noResolve: true },
  });
  const files = new Map([
    [filename, source],
    [config, configText],
  ]);
  const api = new API({
    cwd: process.cwd(),
    fs: {
      readFile: (file) => files.get(file) ?? serverFS.useOS,
      fileExists: (file) => (files.has(file) ? true : serverFS.useOS),
      directoryExists: serverFS.useOS,
      getAccessibleEntries: serverFS.useOS,
      realpath: (file) =>
        files.has(file) ? serverFS.identity : serverFS.useOS,
      stat: serverFS.useOS,
      writeFile: serverFS.error,
      removeFile: serverFS.error,
    },
  });
  try {
    const snapshot = await api.createSnapshot({ openProjects: [config] });
    const project =
      snapshot.getConfiguredProject(config) ??
      panic("The browser runtime program did not open");
    const ast =
      (await project.program.getSourceFile(filename)) ??
      panic("The browser runtime source did not load");
    const { checker } = project;
    const problems: string[] = [];
    let templateWrites = 0;
    const nodes: ts.Node[] = [];
    const collect = (node: ts.Node): void => {
      nodes.push(node);
      node.forEachChild(collect);
    };
    collect(ast);
    for (const node of nodes) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "fetch" &&
        !(await checker.getSymbolAtLocation(node.expression))
      ) {
        problems.push("network is unavailable");
      }
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
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "innerHTML"
      ) {
        if (!(await hasTemplateBinding(node, checker))) {
          problems.push("markup outside template parsing");
        }
        templateWrites++;
      }
    }
    return { problems, templateWrites };
  } finally {
    await api.close();
  }
};
