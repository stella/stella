import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { collectIdempotentCreateRoutes } from "@stll/scripts/src/idempotent-create-routes";

import { apiRoutes } from "@/api/api-routes";

import { mountedCreateRouteCensus } from "../../scripts/idempotent-create-routes";

const apiRoot = path.resolve(import.meta.dir, "../..");

// These lifecycle boundaries cannot retain a scoped JSON replay receipt.
const IDEMPOTENCY_EXCEPTIONS = {
  "src/handlers/account-exports/create.ts":
    "Retains native account-scoped request serialization and durable queue handoff.",
  "src/handlers/api-keys/create.ts":
    "The one-time response contains credential material that must not be retained.",
  "src/handlers/api-keys/personal/create.ts":
    "The one-time response contains credential material that must not be retained.",
  "src/handlers/chat/export/create.ts":
    "Writes an export object to S3 outside the database transaction.",
  "src/handlers/chat/fork/create.ts":
    "Copies S3 objects and retains its native fork deduplication and cleanup lifecycle.",
  "src/handlers/chat/tool-grants/create.ts":
    "Retains native grant deduplication by subject and scope.",
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
  "src/handlers/workspaces/correspondence/address/create.ts":
    "Rotates an inbound address containing a generated credential that must not be retained in replay receipts.",
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
  const nonJsonConstructs: ts.Node[] = [];
  walk(tree, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["Response", "ReadableStream", "Blob", "File"].includes(
        node.expression.text,
      )
    ) {
      nonJsonConstructs.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "stream"
    ) {
      nonJsonConstructs.push(node);
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
    const declaresReplay =
      type !== undefined && ts.isStringLiteral(type) && type.text === "replay";
    const mcpExpression = config ? property(config, "mcp") : undefined;
    const mcp = mcpExpression ? resolve(mcpExpression) : undefined;
    const reason = mcp ? property(mcp, "reason") : undefined;
    if (
      declaresReplay &&
      reason !== undefined &&
      ts.isStringLiteral(reason) &&
      reason.text === "provider_secret"
    ) {
      throw new TypeError(
        "Credential-bearing handlers cannot retain replay receipts",
      );
    }
    eligible.push(declaresReplay);
  });
  return (
    nonJsonConstructs.length === 0 &&
    eligible.length > 0 &&
    eligible.every(Boolean)
  );
};

test("every create route and capability declares JSON request replay or a reasoned exception", async () => {
  const mounted = await mountedCreateRouteCensus();
  expect(mounted.length).toBeGreaterThan(75);
  const served = new Set(
    apiRoutes.map(({ method, path: routePath }) => `${method} ${routePath}`),
  );
  for (const route of mounted) {
    expect(served.has(`${route.method} ${route.path}`)).toBe(true);
  }
  expect(mounted).toContainEqual({
    method: "POST",
    path: "/v1/api-keys",
    file: "src/handlers/api-keys/create.ts",
    replay: false,
  });
  const creates = new Set(mounted.map(({ file }) => file));
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

test("the create census follows mounted handler identities and capability owners", () => {
  const create = { config: { idempotency: { type: "replay" } } };
  const update = { config: {} };
  expect(
    collectIdempotentCreateRoutes({
      routes: [
        { method: "POST", path: "/v1/items", definition: create },
        { method: "PUT", path: "/v1/items/new", definition: create },
        { method: "GET", path: "/v1/items", definition: create },
        { method: "POST", path: "/v1/items/update", definition: update },
      ],
      endpoints: [
        {
          file: "src/handlers/items/create.ts",
          definition: create,
          create: true,
        },
        {
          file: "src/handlers/items/update.ts",
          definition: update,
          create: false,
        },
      ],
    }),
  ).toEqual([
    {
      method: "POST",
      path: "/v1/items",
      file: "src/handlers/items/create.ts",
      replay: true,
    },
    {
      method: "PUT",
      path: "/v1/items/new",
      file: "src/handlers/items/create.ts",
      replay: true,
    },
  ]);
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

test("the create census rejects replay of generated credentials", () => {
  for (const handler of ["createSafeHandler", "createSafeRootHandler"]) {
    expect(() =>
      hasReplayConfig(`
      const access = { type: "internal", reason: "provider_secret" };
      const config = {
        idempotency: { type: "replay" },
        mcp: access,
      } satisfies HandlerConfig;
      ${handler}(config, () => Result.ok({ credential: "generated" }));
    `),
    ).toThrow("Credential-bearing handlers cannot retain replay receipts");
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
