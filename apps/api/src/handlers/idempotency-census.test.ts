import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dir, "../..");

// These lifecycle boundaries cannot retain a scoped JSON replay receipt.
const IDEMPOTENCY_EXCEPTIONS = {
  "src/handlers/api-keys/create.ts":
    "The one-time response contains credential material that must not be retained.",
  "src/handlers/api-keys/personal/create.ts":
    "The one-time response contains credential material that must not be retained.",
  "src/handlers/chat/export/create.ts":
    "Writes an export object to S3 outside the database transaction.",
  "src/handlers/chat/fork/create.ts":
    "Copies S3 objects and retains its native fork deduplication and cleanup lifecycle.",
  "src/handlers/document-translations/runs/create.ts":
    "Retains durable run admission and worker handoff outside the request transaction.",
  "src/handlers/entities/bilingual/create.ts":
    "Creates stored document bytes through the durable upload lifecycle.",
  "src/handlers/entities/blank-document/create.ts":
    "Creates stored document bytes through the durable upload lifecycle.",
  "src/handlers/entities/from-legal-source/create.ts":
    "Creates stored document bytes through the durable upload lifecycle.",
  "src/handlers/entities/ocr/create.ts":
    "Retains native processing-run deduplication by source version.",
  "src/handlers/feedback/create.ts":
    "Submits to the detached feedback store outside the organization transaction.",
  "src/handlers/files/email-attachment/create.ts":
    "Saves attachment bytes through the durable upload lifecycle.",
  "src/handlers/flows/create.ts":
    "Synchronizes the scheduled trigger after the database mutation.",
  "src/handlers/lists/items/comments/create.ts":
    "Fans out mention notifications after the comment transaction commits.",
  "src/handlers/lists/sample-case/create.ts":
    "Retains its native sample deduplication and durable document upload lifecycle.",
  "src/handlers/lists/verifications/create.ts":
    "Retains durable run admission and queue handoff outside the request transaction.",
  "src/handlers/style-sets/create.ts":
    "Stores a style package through the durable upload lifecycle.",
  "src/handlers/style-sets/from-editor/create.ts":
    "Stores generated style-package bytes through the durable upload lifecycle.",
  "src/handlers/template-packs/installs/create.ts":
    "Retains native install deduplication while storing templates through durable uploads.",
  "src/handlers/templates/blank/create.ts":
    "Stores generated template bytes through the durable upload lifecycle.",
  "src/handlers/templates/create.ts":
    "Stores template bytes through the durable upload lifecycle.",
  "src/handlers/templates/fills/create.ts":
    "Creates filled document bytes through the durable upload lifecycle.",
  "src/handlers/templates/from-style-set/create.ts":
    "Stores generated template bytes through the durable upload lifecycle.",
  "src/handlers/templates/from-styles/create.ts":
    "Stores generated template bytes through the durable upload lifecycle.",
  "src/handlers/desktop-time-entries/create.ts":
    "Public desktop authentication establishes its organization inside the handler.",
  "src/handlers/legal-reader/answers/create.ts":
    "The response is a realtime stream, not a JSON document.",
  "src/handlers/uploads/create.ts":
    "Creates expiring entity-create or entity-version upload intents; signed URLs expire and abort removes the intent, while resource identity is established by finalization.",
} as const satisfies Record<string, string>;

const parse = (source: string) =>
  ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);

const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

const resolveImport = (file: string, specifier: string) => {
  if (specifier.startsWith("@/api/")) {
    return `src/${specifier.slice("@/api/".length)}.ts`;
  }
  if (specifier.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), `${specifier}.ts`),
    );
  }
  return undefined;
};

const collectCreateRoutes = (file: string, source: string) => {
  if (!/\b(?:post|put)\b/u.test(source)) {
    return new Set<string>();
  }
  const tree = parse(source);
  const imports = new Map<string, string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const name = statement.importClause?.name;
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (name && target) {
      imports.set(name.text, target);
    }
  }
  const handlers = new Set<string>();
  walk(tree, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression)
    ) {
      return;
    }
    if (
      node.expression.name.text !== "put" &&
      node.expression.name.text !== "post"
    ) {
      return;
    }
    const handler = node.arguments.at(1);
    if (
      !handler ||
      !ts.isPropertyAccessExpression(handler) ||
      handler.name.text !== "handler" ||
      !ts.isIdentifier(handler.expression)
    ) {
      return;
    }
    const target = imports.get(handler.expression.text);
    if (target?.endsWith("/create.ts")) {
      handlers.add(target);
    }
  });
  return handlers;
};

const collectCreateCapabilities = (source: string) => {
  const tree = parse(source);
  const handlers = new Set<string>();
  walk(tree, (node) => {
    if (
      !ts.isPropertyAssignment(node) ||
      !ts.isStringLiteral(node.name) ||
      !node.name.text.endsWith(".create")
    ) {
      return;
    }
    walk(node.initializer, (child) => {
      if (
        !ts.isCallExpression(child) ||
        child.expression.kind !== ts.SyntaxKind.ImportKeyword
      ) {
        return;
      }
      const target = child.arguments.at(0);
      if (target && ts.isStringLiteral(target)) {
        const resolved = resolveImport("", target.text);
        if (resolved) {
          handlers.add(resolved);
        }
      }
    });
  });
  return handlers;
};

const property = (object: ts.ObjectLiteralExpression, name: string) =>
  object.properties.find(
    (entry): entry is ts.PropertyAssignment =>
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
      entry.name.text === name,
  )?.initializer;

const hasReplayConfig = (source: string) => {
  const tree = parse(source);
  const declarations = new Map<string, ts.Expression>();
  walk(tree, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declarations.set(node.name.text, node.initializer);
    }
  });
  const resolve = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): ts.ObjectLiteralExpression | undefined => {
    if (ts.isObjectLiteralExpression(expression)) {
      return expression;
    }
    if (
      ts.isSatisfiesExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    ) {
      return resolve(expression.expression, seen);
    }
    if (!ts.isIdentifier(expression) || seen.has(expression.text)) {
      return undefined;
    }
    seen.add(expression.text);
    const initializer = declarations.get(expression.text);
    return initializer ? resolve(initializer, seen) : undefined;
  };
  let constructsNonJson = false;
  walk(tree, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Response", "ReadableStream", "Blob", "File"].includes(
        node.expression.text,
      )
    ) {
      constructsNonJson = true;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "stream"
    ) {
      constructsNonJson = true;
    }
  });
  const eligible: boolean[] = [];
  walk(tree, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !/^createSafe(?:Root)?Handler$/u.test(node.expression.text)
    ) {
      return;
    }
    const configExpression = node.arguments.at(0);
    const config = configExpression ? resolve(configExpression) : undefined;
    const idempotency = config ? property(config, "idempotency") : undefined;
    const replay = idempotency ? resolve(idempotency) : undefined;
    const type = replay ? property(replay, "type") : undefined;
    eligible.push(
      type !== undefined && ts.isStringLiteral(type) && type.text === "replay",
    );
  });
  return !constructsNonJson && eligible.length > 0 && eligible.every(Boolean);
};

test("every create route and capability declares JSON request replay or a reasoned exception", () => {
  const creates = new Set<string>();
  for (const file of new Bun.Glob("src/handlers/**/*.ts").scanSync({
    cwd: apiRoot,
  })) {
    if (/\.(?:test|type-test)\.ts$/u.test(file)) {
      continue;
    }
    for (const handler of collectCreateRoutes(
      file,
      readFileSync(path.join(apiRoot, file), "utf-8"),
    )) {
      creates.add(handler);
    }
  }
  for (const file of new Bun.Glob(
    "src/mcp/generated/capability-dispatch/*.ts",
  ).scanSync({ cwd: apiRoot })) {
    for (const handler of collectCreateCapabilities(
      readFileSync(path.join(apiRoot, file), "utf-8"),
    )) {
      creates.add(handler);
    }
  }
  expect(creates.size).toBeGreaterThan(80);
  const withoutReplay = [...creates]
    .filter(
      (file) =>
        !hasReplayConfig(readFileSync(path.join(apiRoot, file), "utf-8")),
    )
    .toSorted();
  expect(withoutReplay).toEqual(Object.keys(IDEMPOTENCY_EXCEPTIONS).toSorted());
  for (const reason of Object.values(IDEMPOTENCY_EXCEPTIONS)) {
    expect(reason.length).toBeGreaterThan(20);
  }
});

test("the create census detects relative and aliased routes and capability owners", () => {
  expect([
    ...collectCreateRoutes(
      "src/handlers/example/routes.ts",
      `
    import save from "./create";
    import other from "./update";
    app.put("/", save.handler).post("/", save.handler).post("/update", other.handler);
  `,
    ),
  ]).toEqual(["src/handlers/example/create.ts"]);
  expect([
    ...collectCreateCapabilities(`
    export const dispatch = {
      "example.create": { load: () => import("@/api/handlers/example/save") },
      "example.update": { load: () => import("@/api/handlers/example/update") }
    };
  `),
  ]).toEqual(["src/handlers/example/save.ts"]);
});

test("the create census rejects missing, unrelated and disabled replay declarations", () => {
  for (const config of ["{}", '{ idempotency: { type: "disabled" } }']) {
    expect(
      hasReplayConfig(`
      const unrelated = { idempotency: { type: "replay" } };
      createSafeHandler(${config}, handler);
    `),
    ).toBe(false);
  }
  expect(
    hasReplayConfig(`
    const config = { idempotency: { type: "replay" } } satisfies HandlerConfig;
    createSafeRootHandler(config, handler);
  `),
  ).toBe(true);
});

test("the create census rejects direct response and stream replay", () => {
  for (const result of [
    "new Response(body)",
    "new ReadableStream()",
    "request.stream(body)",
  ]) {
    expect(
      hasReplayConfig(`
      createSafeRootHandler({ idempotency: { type: "replay" } }, () => ${result});
    `),
    ).toBe(false);
  }
});

const exceptionKeys = (source: string) => {
  let keys: string[] | undefined;
  walk(parse(source), (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== "IDEMPOTENCY_EXCEPTIONS" ||
      !node.initializer
    ) {
      return;
    }
    let object = node.initializer;
    while (ts.isSatisfiesExpression(object) || ts.isAsExpression(object)) {
      object = object.expression;
    }
    if (!ts.isObjectLiteralExpression(object)) {
      return;
    }
    keys = object.properties.flatMap((entry) =>
      ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.name)
        ? [entry.name.text]
        : [],
    );
  });
  return keys;
};

const addedExceptions = (base: string, current: readonly string[]) => {
  const previous = exceptionKeys(base);
  if (previous === undefined) {
    throw new TypeError("Base idempotency exception inventory is missing");
  }
  return current.filter((key) => !previous.includes(key));
};

// Compare one pinned tree rather than walking commit history. The first guard
// lands with the explicitly reasoned inventory above; subsequent changes shrink it.
test("the create replay exception inventory only shrinks", () => {
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: path.resolve(apiRoot, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
  const base = git(["merge-base", "origin/main", "HEAD"]);
  expect(base.exitCode).toBe(0);
  const sha = base.stdout.toString().trim();
  const file = "apps/api/src/handlers/idempotency-census.test.ts";
  const exists = git(["ls-tree", "--name-only", sha, "--", file]);
  expect(exists.exitCode).toBe(0);
  if (exists.stdout.toString().trim() === "") {
    return;
  }
  const previous = git(["show", `${sha}:${file}`]);
  expect(previous.exitCode).toBe(0);
  expect(
    addedExceptions(
      previous.stdout.toString(),
      Object.keys(IDEMPOTENCY_EXCEPTIONS),
    ),
  ).toEqual([]);
});

test("the exception shrink guard detects new and substituted handlers", () => {
  const base =
    'const IDEMPOTENCY_EXCEPTIONS = { "one": "Written reason" } as const satisfies Record<string, string>;';
  expect(addedExceptions(base, [])).toEqual([]);
  expect(addedExceptions(base, ["one"])).toEqual([]);
  expect(addedExceptions(base, ["one", "two"])).toEqual(["two"]);
  expect(addedExceptions(base, ["two"])).toEqual(["two"]);
  expect(() => addedExceptions("export {};", [])).toThrow(
    "Base idempotency exception inventory is missing",
  );
});
