import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

// The API process boundary needs the raw executable. This list only shrinks.
export const GITHUB_COMMAND_OWNERS = {
  "scripts/gh-retry.sh":
    "Owns HTTP classification, operation safety and retry budgets.",
} as const;
const OWNER_LIMIT = 1;
const RAW_COMMAND =
  /(?:^|[\s;|(&])(?:command\s+|exec\s+)?["']?(?:[\w.\-/]+\/)?gh["']?\s+(?:(?:api|run|release)\b|["']?\$)|\bcurl\b[^\n]*https:\/\/api\.github\.com\b/u;

// Echo and printf arguments execute substitutions except inside single quotes.
type ShellSubstitution = { text: string; offset: number };

type SubstitutionEndOptions = {
  source: string;
  start: number;
  backtick: boolean;
};
const substitutionEnd = ({
  source,
  start,
  backtick,
}: SubstitutionEndOptions): number => {
  let depth = 1;
  let innerQuote: "'" | '"' | null = null;
  let innerAnsiQuote = false;
  let end = start;
  for (; end < source.length; end += 1) {
    const inner = source[end];
    if (inner === "\\" && (innerQuote !== "'" || innerAnsiQuote)) {
      end += 1;
      continue;
    }
    if (innerQuote !== null) {
      if (inner === innerQuote) {
        innerQuote = null;
      }
      continue;
    }
    if (inner === "'" || inner === '"') {
      innerAnsiQuote = inner === "'" && source[end - 1] === "$";
      innerQuote = inner;
      continue;
    }
    if (backtick) {
      if (inner === "`") {
        break;
      }
      continue;
    }
    if (inner === "(") {
      depth += 1;
    }
    if (inner === ")" && --depth === 0) {
      break;
    }
  }
  return end;
};

const proseSubstitutions = (source: string): ShellSubstitution[] => {
  const substitutions: ShellSubstitution[] = [];
  let quote: "'" | '"' | null = null;
  let ansiQuote = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && (quote !== "'" || ansiQuote)) {
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === "'" && quote === null) {
      ansiQuote = source[index - 1] === "$";
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    const backtick = character === "`";
    if (!backtick && !(character === "$" && source[index + 1] === "(")) {
      continue;
    }
    const start = index + (backtick ? 1 : 2);
    const end = substitutionEnd({ source, start, backtick });
    const body = source.slice(start, end);
    for (const command of shellCommands(body)) {
      if (/^\s*(?:echo|printf)\b/u.test(command.text)) {
        for (const nested of proseSubstitutions(command.text)) {
          substitutions.push({
            text: nested.text,
            offset: start + command.offset + nested.offset,
          });
        }
      } else {
        substitutions.push({
          text: command.text,
          offset: start + command.offset,
        });
      }
    }
    index = end;
  }
  return substitutions;
};

const shellCommands = (source: string): ShellSubstitution[] => {
  // Keep offsets stable while joining shell continuations, so diagnostics
  // still refer to physical source lines rather than logical commands.
  const joined = source.replaceAll(/\\\n/gu, "  ");
  const commands: { text: string; offset: number }[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let ansiQuote = false;
  for (let index = 0; index < joined.length; index += 1) {
    const character = joined[index];
    if (character === "\\" && (quote !== "'" || ansiQuote)) {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      ansiQuote = character === "'" && joined[index - 1] === "$";
      quote = character;
      continue;
    }
    if (
      character === "#" &&
      (index === start || /\s/u.test(joined[index - 1] ?? ""))
    ) {
      const newline = joined.indexOf("\n", index);
      commands.push({ text: joined.slice(start, index), offset: start });
      if (newline === -1) {
        start = joined.length;
        break;
      }
      index = newline;
      start = index + 1;
      continue;
    }
    if (
      character === "\n" ||
      character === ";" ||
      character === "|" ||
      character === "&"
    ) {
      commands.push({ text: joined.slice(start, index), offset: start });
      if (
        joined[index + 1] === character &&
        (character === "|" || character === "&")
      ) {
        index += 1;
      }
      start = index + 1;
    }
  }
  commands.push({ text: joined.slice(start), offset: start });
  return commands;
};

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
    const commands = shellCommands(source);
    const lines = new Set<number>();
    for (const command of commands) {
      const trimmed = command.text.trimStart();
      // Quoted echo/printf arguments are prose; substitutions still execute.
      const candidates = /^(?:echo|printf)\b/u.test(trimmed)
        ? proseSubstitutions(command.text)
        : [{ text: command.text, offset: 0 }];
      for (const candidate of candidates) {
        const match = RAW_COMMAND.exec(candidate.text);
        if (match === null) {
          continue;
        }
        const position =
          command.offset +
          candidate.offset +
          match.index +
          (/^\s*/u.exec(match[0])?.[0].length ?? 0);
        lines.add(source.slice(0, position).split("\n").length);
      }
    }
    return [...lines];
  }

  const ast = parseSource(file, source);
  const lines = new Set<number>();
  const stringValue = (node: Node | null | undefined): string | undefined => {
    if (node?.type === "Literal" && typeof node.value === "string") {
      return node.value;
    }
    if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
      return node.quasis.at(0)?.value.cooked ?? undefined;
    }
    return undefined;
  };
  const stringLiteral = (node: Node | null | undefined): string | undefined =>
    node?.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;
  const rawCommand = (node: Node | null | undefined) =>
    !node ||
    node.type === "SpreadElement" ||
    node.type === "Identifier" ||
    ["api", "run", "release"].includes(stringLiteral(node) ?? "");
  walk(ast.program, (node) => {
    if (node.type === "CallExpression") {
      const argument = node.arguments.at(0);
      const options = node.arguments.at(1);
      if (
        /(?:^|[/\\])gh(?:\.exe)?$/u.test(stringLiteral(argument) ?? "") &&
        options?.type === "ArrayExpression" &&
        rawCommand(options.elements.at(0))
      ) {
        lines.add(ast.locate(node.start).line);
      }
      const argumentText = stringValue(argument);
      if (argumentText !== undefined && RAW_COMMAND.test(argumentText)) {
        lines.add(ast.locate(node.start).line);
      }
    }
    if (
      node.type === "TemplateLiteral" &&
      node.expressions.length > 0 &&
      RAW_COMMAND.test(node.quasis.at(0)?.value.cooked ?? "")
    ) {
      lines.add(ast.locate(node.start).line);
    }
    if (
      node.type === "ArrayExpression" &&
      /(?:^|[/\\])gh(?:\.exe)?$/u.test(
        stringLiteral(node.elements.at(0)) ?? "",
      ) &&
      rawCommand(node.elements.at(1))
    ) {
      lines.add(ast.locate(node.start).line);
    }
  });
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
