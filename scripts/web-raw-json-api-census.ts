import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import type {
  BindingPattern,
  BindingRestElement,
  Expression,
  FormalParameterRest,
  Node,
  TSParameterProperty,
} from "../packages/scripts/src/syntax-tree";
import { staticPropertyName, walk } from "../packages/scripts/src/syntax-tree";
import { parseSyntax } from "./parse-memo";

const WEB_SOURCE_ROOT = path.resolve(import.meta.dir, "../apps/web/src");
const READER_ANSWER_STREAM_CALL =
  "features/case-law/components/case-viewer/reader-answers-query.ts#`/reader/answers$" +
  "{path}`";

/** Raw transport is reserved for responses the typed JSON client cannot consume. */
const RAW_JSON_STREAM_ALLOWLIST = {
  "components/ai-suggestions/document-review-proposal-stream.ts#proposalStreamUrl(workspaceId)":
    "Consumes incremental document-review proposal output.",
  'components/autocomplete/use-autocomplete-stream.ts#"/ai-autocomplete/stream"':
    "Consumes incremental autocomplete output.",
  [READER_ANSWER_STREAM_CALL]: "Consumes the streamed reader-answer response.",
  'routes/dev/-components/autocomplete-playground.tsx#"/ai-autocomplete/stream"':
    "Exercises the same incremental autocomplete stream in development.",
} as const satisfies Record<string, string>;

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;
const TEST_MODULE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const walkFiles = async (directory: string): Promise<string[]> => {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walkFiles(entryPath)));
    } else if (
      SOURCE_EXTENSION.test(entry.name) &&
      !TEST_MODULE.test(entryPath)
    ) {
      paths.push(entryPath);
    }
  }
  return paths;
};

const isJsonStringify = (expression: Expression | undefined): boolean =>
  expression?.type === "CallExpression" &&
  expression.callee.type === "MemberExpression" &&
  !expression.callee.computed &&
  expression.callee.object.type === "Identifier" &&
  expression.callee.object.name === "JSON" &&
  expression.callee.property.type === "Identifier" &&
  expression.callee.property.name === "stringify";

const resolvesToJsonStringify = (
  expression: Expression | undefined,
  ancestors: readonly Node[],
): boolean =>
  isJsonStringify(expression) ||
  (expression?.type === "Identifier" &&
    isJsonStringify(
      resolveLexicalBinding(expression.name, ancestors)?.expression,
    ));

const bindingNames = (
  binding:
    | BindingPattern
    | BindingRestElement
    | FormalParameterRest
    | TSParameterProperty,
): string[] => {
  if (binding.type === "TSParameterProperty") {
    return bindingNames(binding.parameter);
  }
  if (binding.type === "Identifier") {
    return [binding.name];
  }
  if (binding.type === "AssignmentPattern") {
    return bindingNames(binding.left);
  }
  if (binding.type === "RestElement") {
    return bindingNames(binding.argument);
  }
  if (binding.type === "ArrayPattern") {
    return binding.elements.flatMap((element) =>
      element === null ? [] : bindingNames(element),
    );
  }
  return binding.properties.flatMap((property) =>
    bindingNames(
      property.type === "RestElement" ? property.argument : property.value,
    ),
  );
};

const resolveLexicalBinding = (
  name: string,
  ancestors: readonly Node[],
): { expression: Expression; ancestors: readonly Node[] } | undefined => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const scope = ancestors[index];
    if (scope === undefined) {
      continue;
    }
    if (
      (scope.type === "FunctionDeclaration" ||
        scope.type === "FunctionExpression" ||
        scope.type === "ArrowFunctionExpression") &&
      scope.params.some((parameter) => bindingNames(parameter).includes(name))
    ) {
      return undefined;
    }
    const statements =
      scope.type === "Program" || scope.type === "BlockStatement"
        ? scope.body
        : [];
    for (const statement of statements) {
      if (statement.type !== "VariableDeclaration") {
        continue;
      }
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type === "Identifier" &&
          declaration.id.name === name
        ) {
          return declaration.init === null
            ? undefined
            : {
                expression: declaration.init,
                ancestors: ancestors.slice(0, index + 1),
              };
        }
      }
    }
  }
  return undefined;
};

export type RawJsonApiCensus = {
  violations: string[];
  staleAllowlist: string[];
};

export const censusRawJsonApiCalls = async (
  paths: readonly string[],
  sourceRoot = WEB_SOURCE_ROOT,
  allowlist: Readonly<Record<string, string>> = RAW_JSON_STREAM_ALLOWLIST,
): Promise<RawJsonApiCensus> => {
  const calls = new Set<string>();
  for (const filePath of paths) {
    const source = await readFile(filePath, "utf-8");
    const { program } = parseSyntax({ fileName: filePath, text: source });
    const modulePath = repoRelativePath(sourceRoot, filePath);
    walk(program, (node, ancestors) => {
      if (
        node.type !== "CallExpression" ||
        node.callee.type !== "Identifier" ||
        (node.callee.name !== "fetch" &&
          node.callee.name !== "fetchWithTimeout") ||
        node.arguments[0]?.type !== "CallExpression" ||
        node.arguments[0].callee.type !== "Identifier" ||
        node.arguments[0].callee.name !== "apiUrl"
      ) {
        return;
      }
      const optionsArgument = node.arguments[1];
      let options: Expression | undefined;
      let optionsAncestors = ancestors;
      if (optionsArgument?.type === "ObjectExpression") {
        options = optionsArgument;
      } else if (optionsArgument?.type === "Identifier") {
        const binding = resolveLexicalBinding(optionsArgument.name, ancestors);
        options = binding?.expression;
        optionsAncestors = binding?.ancestors ?? ancestors;
      }
      if (options?.type !== "ObjectExpression") {
        return;
      }
      const body = options.properties.find(
        (property) =>
          property.type === "Property" &&
          staticPropertyName(property) === "body",
      );
      if (
        body?.type !== "Property" ||
        !resolvesToJsonStringify(body.value, optionsAncestors)
      ) {
        return;
      }
      const urlArgument = node.arguments[0].arguments[0];
      if (urlArgument === undefined) {
        return;
      }
      const identity = source
        .slice(urlArgument.start, urlArgument.end)
        .replaceAll(/\s+/gu, "");
      calls.add(`${modulePath}#${identity}`);
    });
  }
  return {
    violations: [...calls].filter((call) => !(call in allowlist)).toSorted(),
    staleAllowlist: Object.keys(allowlist)
      .filter((call) => !calls.has(call))
      .toSorted(),
  };
};

export const findRawJsonApiCalls = async (
  paths: readonly string[],
  sourceRoot = WEB_SOURCE_ROOT,
) => (await censusRawJsonApiCalls(paths, sourceRoot, {})).violations;

if (import.meta.main) {
  const report = await censusRawJsonApiCalls(await walkFiles(WEB_SOURCE_ROOT));
  if (report.violations.length > 0 || report.staleAllowlist.length > 0) {
    if (report.violations.length > 0) {
      console.error(
        `JSON API requests must use the typed client:\n${report.violations.map((call) => `- ${call}`).join("\n")}`,
      );
    }
    if (report.staleAllowlist.length > 0) {
      console.error(
        `Raw JSON stream allowlist entries are stale:\n${report.staleAllowlist.map((call) => `- ${call}`).join("\n")}`,
      );
    }
    process.exitCode = 1;
  }
}
