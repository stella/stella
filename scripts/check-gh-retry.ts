import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// The API process boundary needs the raw executable. This list only shrinks.
export const GITHUB_COMMAND_OWNERS = {
  "scripts/gh-retry.sh":
    "Owns HTTP classification, operation safety and retry budgets.",
} as const;
const OWNER_LIMIT = 1;
const RAW_COMMAND =
  /(?:^|[\s;|(&])(?:command\s+|exec\s+)?["']?(?:[\w.\-/]+\/)?gh["']?\s+(?:(?:api|run|release)\b|["']?\$)|\bcurl\b[^\n]*https:\/\/api\.github\.com\b/u;

// Scan every script, not a hand-maintained workflow call graph: a script added
// to CI already has this boundary, including scripts invoked indirectly.
export const githubCommandFiles = (root: string) =>
  [
    ...new Bun.Glob(
      "{scripts,.github,apps,packages}/**/*.{sh,ts,yml,yaml}",
    ).scanSync({
      cwd: root,
      dot: true,
    }),
  ]
    .filter(
      (file) => !file.includes(".test.") && !file.includes("/node_modules/"),
    )
    .toSorted();

export const rawGithubCommands = (file: string, source: string): number[] => {
  if (Object.hasOwn(GITHUB_COMMAND_OWNERS, file)) {
    return [];
  }
  if (!file.endsWith(".ts")) {
    return source
      .replaceAll(/\\\n[ \t]*/gu, " ")
      .split("\n")
      .flatMap((line, index) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("#")) {
          return [];
        }
        // Literal prose is not a shell command. Command substitutions still are.
        if (/^(?:echo|printf)\b/u.test(trimmed) && !trimmed.includes("$(")) {
          return [];
        }
        return RAW_COMMAND.test(line) ? [index + 1] : [];
      });
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines = new Set<number>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const argument = node.arguments.at(0);
      const options = node.arguments.at(1);
      if (
        argument &&
        ts.isStringLiteral(argument) &&
        /(?:^|[/\\])gh(?:\.exe)?$/u.test(argument.text) &&
        options &&
        ts.isArrayLiteralExpression(options)
      ) {
        const command = options.elements.at(0);
        if (
          !command ||
          ts.isSpreadElement(command) ||
          ts.isIdentifier(command) ||
          (ts.isStringLiteral(command) &&
            ["api", "run", "release"].includes(command.text))
        ) {
          lines.add(
            ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          );
        }
      }
      if (
        argument &&
        (ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument)) &&
        RAW_COMMAND.test(argument.text)
      ) {
        lines.add(ast.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    if (ts.isTemplateExpression(node) && RAW_COMMAND.test(node.head.text)) {
      lines.add(ast.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const executable = node.elements.at(0);
      const command = node.elements.at(1);
      if (
        executable &&
        ts.isStringLiteral(executable) &&
        /(?:^|[/\\])gh(?:\.exe)?$/u.test(executable.text) &&
        (!command ||
          ts.isSpreadElement(command) ||
          ts.isIdentifier(command) ||
          (ts.isStringLiteral(command) &&
            ["api", "run", "release"].includes(command.text)))
      ) {
        lines.add(ast.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...lines];
};

export const githubCommandProblems = (root: string) => {
  const files = githubCommandFiles(root);
  const problems = files.flatMap((file) =>
    rawGithubCommands(file, readFileSync(path.join(root, file), "utf-8")).map(
      (line) => `${file}:${line}: use the GitHub API retry owner`,
    ),
  );
  if (Object.keys(GITHUB_COMMAND_OWNERS).length > OWNER_LIMIT) {
    problems.push("GitHub command owner list may only shrink");
  }
  for (const file of Object.keys(GITHUB_COMMAND_OWNERS)) {
    if (!files.includes(file)) {
      problems.push(`${file}: command owner must exist`);
    }
  }
  return problems;
};

if (import.meta.main) {
  const problems = githubCommandProblems(path.resolve(import.meta.dir, ".."));
  if (problems.length > 0) {
    panic(problems.join("\n"));
  }
  console.log("GitHub API commands use the retry owner.");
}
