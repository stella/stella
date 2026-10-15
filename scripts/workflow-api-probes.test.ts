import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { lexShell, programWords } from "./install-free-ci";

const root = path.resolve(import.meta.dir, "..");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
]);
type Route = { method: string; path: string };
type Router = { prefix: string; routes: Route[] };
type Module = {
  declarations: Map<string, ts.Expression>;
  imports: Map<string, { file: string; name: string }>;
};
const modules = new Map<string, Module>();
const moduleFile = (file: string, specifier: string) => {
  if (specifier === "@stll/api-contract") {
    return path.join(root, "packages/api-contract/src/index.ts");
  }
  if (specifier.startsWith("@/api/")) {
    return path.join(root, "apps/api/src", `${specifier.slice(6)}.ts`);
  }
  if (specifier.startsWith(".")) {
    return path.resolve(
      path.dirname(file),
      `${specifier.replace(/\.js$/u, "")}.ts`,
    );
  }
  return undefined;
};
const readModule = (file: string): Module => {
  const cached = modules.get(file);
  if (cached) {
    return cached;
  }
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = new Map<string, ts.Expression>();
  const imports: Module["imports"] = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          declarations.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (ts.isExportAssignment(statement)) {
      declarations.set("default", statement.expression);
    }
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = moduleFile(file, statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (target === undefined || clause === undefined) {
      continue;
    }
    if (clause.name) {
      imports.set(clause.name.text, { file: target, name: "default" });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        imports.set(binding.name.text, {
          file: target,
          name: binding.propertyName?.text ?? binding.name.text,
        });
      }
    }
  }
  const result = { declarations, imports };
  modules.set(file, result);
  return result;
};
const binding = (file: string, name: string) => {
  const module = readModule(file);
  const imported = module.imports.get(name);
  return imported ?? { file, name };
};
const staticText = (
  expression: ts.Expression | undefined,
  file: string,
): string | undefined => {
  if (!expression) {
    return undefined;
  }
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return staticText(expression.expression, file);
  }
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }
  const target = binding(file, expression.text);
  return staticText(
    readModule(target.file).declarations.get(target.name),
    target.file,
  );
};
const join = (prefix: string, suffix: string) =>
  `${prefix}/${suffix}`.replaceAll(/\/+/gu, "/").replace(/\/$/u, "") || "/";
type WalkOptions = {
  file: string;
  prefix: string;
  locals: Map<string, Router>;
  active: Set<string>;
};
const walk = (
  expression: ts.Expression | undefined,
  options: WalkOptions,
): Router | undefined => {
  if (!expression) {
    return undefined;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression)
  ) {
    return walk(expression.expression, options);
  }
  if (ts.isIdentifier(expression)) {
    const local = options.locals.get(expression.text);
    if (local) {
      return local;
    }
    const target = binding(options.file, expression.text);
    const key = `${target.file}:${target.name}:${options.prefix}`;
    if (options.active.has(key)) {
      return undefined;
    }
    const active = new Set(options.active).add(key);
    return walk(readModule(target.file).declarations.get(target.name), {
      ...options,
      file: target.file,
      active,
    });
  }
  if (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Elysia"
  ) {
    const config = expression.arguments?.at(0);
    const property =
      config && ts.isObjectLiteralExpression(config)
        ? config.properties.find(
            (item) =>
              ts.isPropertyAssignment(item) && item.name.getText() === "prefix",
          )
        : undefined;
    const prefix =
      property && ts.isPropertyAssignment(property)
        ? staticText(property.initializer, options.file)
        : "";
    return prefix === undefined
      ? undefined
      : { prefix: join(options.prefix, prefix), routes: [] };
  }
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression)
  ) {
    return undefined;
  }
  const receiver = walk(expression.expression.expression, options);
  if (!receiver) {
    return undefined;
  }
  const method = expression.expression.name.text;
  const first = expression.arguments.at(0);
  const routes = [...receiver.routes];
  if (methods.has(method)) {
    const suffix = staticText(first, options.file);
    if (suffix !== undefined) {
      routes.push({
        method: method.toUpperCase(),
        path: join(receiver.prefix, suffix),
      });
    }
  }
  if (method === "use") {
    routes.push(
      ...(walk(first, { ...options, prefix: receiver.prefix })?.routes ?? []),
    );
  }
  if (method === "group" || method === "guard") {
    const callback = expression.arguments.find(ts.isArrowFunction);
    const group = method === "group" ? staticText(first, options.file) : "";
    const parameter = callback?.parameters.at(0)?.name;
    if (
      callback &&
      parameter &&
      ts.isIdentifier(parameter) &&
      group !== undefined
    ) {
      const prefix = join(receiver.prefix, group);
      const locals = new Map(options.locals).set(parameter.text, {
        prefix,
        routes: [],
      });
      const body = ts.isBlock(callback.body)
        ? callback.body.statements.find(ts.isReturnStatement)?.expression
        : callback.body;
      routes.push(
        ...(walk(body, { ...options, prefix, locals })?.routes ?? []),
      );
    }
  }
  return { ...receiver, routes };
};
const served =
  walk(
    readModule(path.join(root, "apps/api/src/server.ts")).declarations.get(
      "default",
    ),
    {
      file: path.join(root, "apps/api/src/server.ts"),
      prefix: "",
      locals: new Map(),
      active: new Set(),
    },
  )?.routes ?? panic("API route inventory unavailable");

const apiOrigin = /https:\/\/api(?:-staging)?\.stll\.app(?:\/|$)/u;
const references = (value: string) =>
  [...value.matchAll(/\$(?:\{(\w+)(?:%\/)?\}|(\w+))(\/[^\s"'?#]*)?/gu)].flatMap(
    (match) => {
      const name = match[1] ?? match[2];
      return name === undefined ? [] : [{ name, suffix: match[3] ?? "" }];
    },
  );
const records = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) {
    return value.flatMap(records);
  }
  if (!isRecord(value)) {
    return [];
  }
  return [value, ...Object.values(value).flatMap(records)];
};
type Probe = Route & { workflow: string };
type Assignment = { name: string; value: string; output?: string };
const curlTargets = (words: string[]) => {
  let explicit: string | undefined;
  let data = false;
  let get = false;
  let head = false;
  const targets: string[] = [];
  const takesValue = new Set([
    "-H",
    "--header",
    "-o",
    "--output",
    "-w",
    "--write-out",
    "--connect-timeout",
    "--max-time",
    "--retry",
    "-d",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--json",
    "-F",
    "--form",
    "-X",
    "--request",
    "--url",
    "-u",
    "--user",
    "--proxy",
    "--cacert",
    "--cert",
  ]);
  for (let index = 1; index < words.length; index += 1) {
    const word = words.at(index) ?? panic("Missing curl argument");
    if (word === "-G" || word === "--get") {
      get = true;
    }
    if (word === "-I" || word === "--head") {
      head = true;
    }
    if (/^(-d|-F|--data(?:-|=|$)|--json(?:=|$)|--form(?:=|$))/u.test(word)) {
      data = true;
    }
    if (/^-X.+/u.test(word)) {
      explicit = word.slice(2);
    }
    if (word.startsWith("--request=")) {
      explicit = word.slice(10);
    }
    if (word.startsWith("--url=")) {
      targets.push(word.slice(6));
    }
    if (takesValue.has(word)) {
      const value = words.at(index + 1) ?? panic(`Missing curl ${word} value`);
      if (word === "-X" || word === "--request") {
        explicit = value;
      }
      if (word === "--url") {
        targets.push(value);
      }
      index += 1;
      continue;
    }
    if (!word.startsWith("-")) {
      targets.push(word);
    }
  }
  if (explicit !== undefined) {
    return { method: explicit.toUpperCase(), targets };
  }
  if (head) {
    return { method: "HEAD", targets };
  }
  return { method: data && !get ? "POST" : "GET", targets };
};
const probeBindings = (assignments: Assignment[]) => {
  const values = new Map<string, Set<string>>([
    ["E2E_API_URL", new Set(["/"])],
  ]);
  const outputs = new Map<string, Set<string>>();
  let changed = true;
  for (let iteration = 0; changed; iteration += 1) {
    if (iteration > assignments.length + 1) {
      panic("Cyclic API URL aliases cannot be resolved");
    }
    changed = false;
    for (const { name, value, output } of assignments) {
      const paths = [
        ...value.matchAll(
          /https:\/\/api(?:-staging)?\.stll\.app(?:\/[^\s"'${}]+)?/gu,
        ),
      ].map((match) => new URL(match[0]).pathname);
      for (const { name: reference, suffix } of references(value)) {
        paths.push(
          ...[...(values.get(reference) ?? [])].map((prefix) =>
            join(prefix, suffix),
          ),
        );
      }
      for (const [reference, prefixes] of outputs) {
        if (value.includes(reference)) {
          paths.push(...prefixes);
        }
      }
      for (const pathname of paths) {
        const known = values.get(name) ?? new Set<string>();
        if (!known.has(pathname)) {
          known.add(pathname);
          values.set(name, known);
          changed = true;
        }
        if (output !== undefined) {
          const exported = outputs.get(output) ?? new Set<string>();
          if (!exported.has(pathname)) {
            exported.add(pathname);
            outputs.set(output, exported);
            changed = true;
          }
        }
      }
    }
  }
  return values;
};
const jobProbes = (
  objects: Record<string, unknown>[],
  workflow: string,
): Probe[] => {
  const assignments: Assignment[] = [];
  const commands: string[][] = [];
  for (const object of objects) {
    if (isRecord(object["env"])) {
      for (const [name, value] of Object.entries(object["env"])) {
        if (typeof value === "string") {
          assignments.push({ name, value });
        }
      }
    }
    if (typeof object["run"] !== "string") {
      continue;
    }
    const source = object["run"].replaceAll(
      /\$\{\{\s*env\.(\w+)\s*\}\}/gu,
      "$$$1",
    );
    for (const event of lexShell(source)) {
      if (event.type !== "command") {
        continue;
      }
      commands.push([...programWords(event.words)]);
      for (const word of event.words) {
        const match = /^(\w+)=(.*)$/su.exec(word);
        const name = match?.[1];
        const value = match?.[2];
        if (name === undefined || value === undefined) {
          continue;
        }
        const output =
          typeof object["id"] === "string"
            ? `steps.${object["id"]}.outputs.${name}`
            : undefined;
        if (output === undefined) {
          assignments.push({ name, value });
        } else {
          assignments.push({ name, value, output });
        }
      }
    }
  }
  const values = probeBindings(assignments);
  return commands
    .filter((words) => words.at(0) === "curl")
    .flatMap((words) => {
      const { method, targets } = curlTargets(words);
      return targets.flatMap((word) => {
        if (apiOrigin.test(word)) {
          return [{ workflow, method, path: new URL(word).pathname }];
        }
        const match =
          /^\$(?:\{(\w+)(?:%\/)?\}|(\w+))(\/[^?#]*)?(?:[?#].*)?$/u.exec(word);
        const variable = match?.[1] ?? match?.[2];
        if (variable === undefined) {
          return [];
        }
        const suffix = match?.[3] ?? "";
        return [...(values.get(variable) ?? [])].map((prefix) => ({
          workflow,
          method,
          path: join(prefix, suffix),
        }));
      });
    });
};
const probes = (source: string, workflow: string): Probe[] => {
  const parsed: unknown = Bun.YAML.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed["jobs"])) {
    return panic(`${workflow}: workflow jobs unavailable`);
  }
  return Object.entries(parsed["jobs"]).flatMap(([name, job]) =>
    jobProbes([{ env: parsed["env"] }, ...records(job)], `${workflow}/${name}`),
  );
};
const resolves = (probe: Route, inventory = served) => {
  if (probe.method === "GET" && ["/ready", "/health"].includes(probe.path)) {
    return true;
  }
  return inventory.some(
    (route) =>
      (route.method === probe.method || route.method === "ALL") &&
      join("", route.path) === join("", probe.path),
  );
};
test("workflow API curl probes resolve to the mounted API route and method", () => {
  const targets = [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].flatMap((workflow) =>
    probes(readFileSync(path.join(root, workflow), "utf-8"), workflow),
  );
  expect(
    targets.some(
      (target) =>
        target.path === "/v1/case/decisions/search" && target.method === "POST",
    ),
  ).toBe(true);
  for (const target of targets) {
    expect(resolves(target), JSON.stringify(target)).toBe(true);
  }
});
test("route mounting and probe method changes cannot retain a successful search contract", () => {
  const workflow = ".github/workflows/deploy-staging.yml";
  const source = readFileSync(path.join(root, workflow), "utf-8");
  const changed = source.replace(
    ["$", "{E2E_API_URL}/v1/case/decisions/search"].join(""),
    () => ["$", "{E2E_API_URL}/case/decisions/search"].join(""),
  );
  expect(changed).not.toBe(source);
  expect(probes(changed, workflow).some((probe) => !resolves(probe))).toBe(
    true,
  );
  expect(resolves({ method: "GET", path: "/v1/case/decisions/search" })).toBe(
    false,
  );
  expect(
    resolves(
      { method: "POST", path: "/v1/case/decisions/search" },
      served.filter((route) => route.path !== "/v1/case/decisions/search"),
    ),
  ).toBe(false);
});

test("curl request options determine the probed method without treating payloads as URLs", () => {
  const url = "https://api-staging.stll.app/v1/case/decisions/search";
  for (const options of [
    ["-XPOST"],
    ["--request=POST"],
    ["--request", "POST"],
    ["--json", url],
  ]) {
    expect(curlTargets(["curl", ...options, url])).toEqual({
      method: "POST",
      targets: [url],
    });
  }
  expect(curlTargets(["curl", "-I", url])).toEqual({
    method: "HEAD",
    targets: [url],
  });
  expect(curlTargets(["curl", "-G", "-d", url, url])).toEqual({
    method: "GET",
    targets: [url],
  });
  expect(curlTargets(["curl", "-H", url, url])).toEqual({
    method: "GET",
    targets: [url],
  });
});
test("API URL aliases remain scoped to their workflow job", () => {
  const source = `jobs:
  api:
    env:
      API_URL: https://api-staging.stll.app/health
    steps:
      - run: curl "$API_URL?check=1"
  other:
    env:
      API_URL: https://example.com/not-api
    steps:
      - run: curl "$API_URL"
      - run: curl "$API_URL_OTHER"
`;
  expect(probes(source, "fixture")).toEqual([
    { workflow: "fixture/api", method: "GET", path: "/health" },
  ]);
});

test("API aliases preserve path suffixes when resolving probe targets", () => {
  const targets = jobProbes(
    [
      {
        env: {
          ROOT: "https://api-staging.stll.app/health",
          BAD: "$ROOT/not-a-route",
          VERSIONED: "$E2E_API_URL/v1",
        },
        run: 'curl "$BAD"; curl -XPOST "$VERSIONED/case/decisions/search"',
      },
    ],
    "fixture",
  );
  expect(targets.map(({ path: pathname }) => pathname)).toEqual([
    "/health/not-a-route",
    "/v1/case/decisions/search",
  ]);
  expect(targets.map((target) => resolves(target))).toEqual([false, true]);
});
