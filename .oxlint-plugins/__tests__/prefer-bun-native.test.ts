import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import config from "../../oxlint.config.ts";
import {
  type CallExpression,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSource,
  walk,
} from "../../packages/scripts/src/syntax-tree.ts";
import {
  isRecord,
  readScopes,
  ruleIsOff,
  ruleOptions,
  scopeMatches,
} from "../../scripts/oxlint-config-scopes.ts";
import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

const plugin = "prefer-bun-native";

test("rejects byte encodings only on proven Buffer producers and immutable aliases", async () => {
  expect(
    await lintSingleRule(
      "no-buffer-string-encoding",
      [
        'import { Buffer as Bytes } from "node:buffer";',
        'import { randomBytes as random } from "node:crypto";',
        "const bytes = Bytes.from([1, 2]);",
        "const alias = bytes;",
        'alias.toString("hex");',
        'Buffer.from("text").toString("base64");',
        'random(32).toString("base64url");',
        'bytes.subarray(1).toString("hex");',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([5, 6, 7, 8]);
});

test("custom methods, shadowed constructors, mutable bindings and parameters remain valid", async () => {
  expect(
    await lintSingleRule(
      "no-buffer-string-encoding",
      [
        'const custom = { toString: (format: "hex") => format };',
        'custom.toString("hex");',
        '{ const Buffer = { from: () => custom }; Buffer.from().toString("hex"); }',
        "let bytes = Buffer.from([1]);",
        "bytes = Buffer.from([2]);",
        'bytes.toString("hex");',
        'function format(value: { toString: (format: "hex") => string }) { return value.toString("hex"); }',
        "(255).toString(16);",
        'Buffer.from("text").toString("utf8");',
        'const changed = Buffer.from("text"); changed.toString = () => "custom"; changed.toString("hex");',
        'const original = Buffer.from("text"); const changedAlias = original; changedAlias.toString = () => "custom"; original.toString("hex");',
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("rewrites proven direct encodings without changing receiver evaluation", async () => {
  const source = [
    "declare const input: () => string;",
    'const a = Buffer.from(input()).toString("hex");',
    'const b = Buffer.from("text").toString("base64");',
    'const c = Buffer.from("text").toString("base64url");',
  ].join("\n");
  const fixed = await runSingleRule("no-buffer-string-encoding", source, {
    plugin,
    fix: true,
  });
  expect(fixed.source).toBe(
    [
      "declare const input: () => string;",
      "const a = Buffer.from(input()).toHex();",
      'const b = Buffer.from("text").toBase64();',
      'const c = Buffer.from("text").toBase64({ alphabet: "base64url", omitPadding: true });',
    ].join("\n"),
  );
  expect(fixed.lines).toEqual([]);
});

test("optional and computed byte calls have no automatic replacement", async () => {
  const source = [
    'Buffer.from("text")?.toString("hex");',
    'Buffer.from("text").toString?.("base64");',
    'Buffer.from("text")["toString"]("base64url");',
  ].join("\n");
  const fixed = await runSingleRule("no-buffer-string-encoding", source, {
    plugin,
    fix: true,
  });
  expect(fixed.source).toBe(source);
  expect(fixed.lines).toEqual([1, 2, 3]);
});

test("Headers records require native constructor or awaited fetch provenance", async () => {
  expect(
    await lintSingleRule(
      "no-headers-from-entries",
      [
        "const NativeHeaders = Headers;",
        'const headers = new NativeHeaders({ a: "1" });',
        "const alias = headers;",
        'const request = new Request("https://example.test");',
        "const response = new Response();",
        'const fetched = await fetch("https://example.test");',
        "Object.fromEntries(alias.entries());",
        "Object.fromEntries(request.headers);",
        "Object.fromEntries(response.clone().headers.entries());",
        "Object.fromEntries(fetched.headers);",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([7, 8, 9, 10]);
});

test("custom headers, shadowed globals, reassigned values and unproven request parameters remain valid", async () => {
  expect(
    await lintSingleRule(
      "no-headers-from-entries",
      [
        'const request = { headers: new Map([["a", "1"]]) };',
        "Object.fromEntries(request.headers);",
        '{ const Headers = Map; Object.fromEntries(new Headers([["a", "1"]])); }',
        "{ const Object = { fromEntries: (value: Headers) => value }; Object.fromEntries(new Headers()); }",
        "function record(request: Request) { return Object.fromEntries(request.headers); }",
        "let headers = new Headers();",
        "headers = new Headers();",
        "Object.fromEntries(headers);",
      ].join("\n"),
      { plugin },
    ),
  ).toEqual([]);
});

test("native Headers records stay report-only to preserve set-cookie decisions", async () => {
  const source = 'Object.fromEntries(new Headers({ "set-cookie": "a=1" }));';
  const fixed = await runSingleRule("no-headers-from-entries", source, {
    plugin,
    fix: true,
  });
  expect(fixed.source).toBe(source);
  expect(fixed.lines).toEqual([1]);
});

type EffectiveRuleOptions = { file: string; rule: string };
const effectiveRule = ({ file, rule }: EffectiveRuleOptions) => {
  let result: unknown;
  for (const scope of readScopes(config)) {
    if (scopeMatches(scope, file) && Object.hasOwn(scope.rules, rule)) {
      result = scope.rules[rule];
    }
  }
  return result;
};

const encodingRule = "prefer-bun-native/no-buffer-string-encoding";
const hmacRule = "no-raw-sha256/no-raw-sha256";

test("Bun preferences use exact files and preserve the canonical SHA owner options", () => {
  const nativeScopes = readScopes(config).filter(
    (scope) =>
      Object.hasOwn(scope.rules, encodingRule) &&
      ruleOptions(scope.rules[hmacRule]).some(
        (option) =>
          typeof option === "object" &&
          option !== null &&
          Reflect.get(option, "hmacTarget") === "bun",
      ),
  );
  expect(nativeScopes).toHaveLength(1);
  const scope = nativeScopes.at(0);
  expect(scope).toBeDefined();
  if (scope === undefined) {
    return;
  }
  expect(scope.excludeFiles).toEqual([]);
  expect(scope.files.every((file) => !/[*?{}[\]]/u.test(file))).toBe(true);
  const base = readScopes(config).at(0);
  const baseOptions = ruleOptions(base?.rules[hmacRule]).at(0);
  expect(isRecord(baseOptions)).toBe(true);
  if (!isRecord(baseOptions)) {
    return;
  }
  for (const file of scope.files) {
    expect(ruleOptions(effectiveRule({ file, rule: hmacRule }))).toEqual([
      { ...baseOptions, hmacTarget: "bun" },
    ]);
  }
});

test.each([
  "apps/api/src/lib/content-encryption.ts",
  "apps/collab/src/server.ts",
  "apps/web/src/lib/desktop-bridge.test.ts",
  "packages/scripts/src/dev-runtime.ts",
  "packages/agent-engine/src/bun-docker/provider.ts",
])("verified Bun file receives native preferences: %s", (file) => {
  expect(effectiveRule({ file, rule: encodingRule })).toBe("error");
});

test.each([
  "apps/api/src/new-unreviewed-encoding.ts",
  "apps/web/src/new.worker.ts",
  "apps/mobile/src/app.tsx",
  "apps/playground/src/main.tsx",
  "apps/visual-preview/src/handler.ts",
  "packages/cli/src/sha256.ts",
  "packages/mcp-kit/src/index.ts",
  "packages/anonymize-chat/src/index.ts",
  "packages/sha256/src/node.ts",
  "packages/sha256/src/browser.ts",
  "packages/sha256/src/encoding.ts",
  "packages/agent-engine/scripts/mcp-canary-server.ts",
  "packages/new-package/src/index.ts",
])("unenrolled targets never inherit native preferences: %s", (file) => {
  const native = effectiveRule({ file, rule: encodingRule });
  expect(native === undefined || ruleIsOff(native)).toBe(true);
  expect(
    ruleOptions(effectiveRule({ file, rule: hmacRule })),
  ).not.toContainEqual(expect.objectContaining({ hmacTarget: "bun" }));
});

type ParsedSource = ReturnType<typeof parseSource>;

const hasDockerApiRuntimeCall = (source: ParsedSource) => {
  const bindings = new Set(
    source.module.staticImports
      .filter((statement) => statement.moduleRequest.value === "./api")
      .flatMap((statement) =>
        statement.entries.flatMap(({ importName, isType, localName }) => {
          // oxc-parser declares the kind as an ambient const enum of strings.
          const kind: string = importName.kind;
          return !isType && kind === "Name" ? [localName.value] : [];
        }),
      ),
  );
  let called = false;
  walk(source.program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      bindings.has(node.callee.name)
    ) {
      called = true;
    }
  });
  return called;
};

type FetchCall = {
  readonly call: CallExpression;
  /** The call's ancestors, nearest last. */
  readonly ancestors: readonly Node[];
};

// This owner uses inline objects or direct const objects in the fetch's block.
// Aliases, outer scopes and control-flow reconstruction are unproven.
const fetchOptionsObject = ({ call, ancestors }: FetchCall) => {
  const expression = call.arguments.at(1);
  if (expression === undefined) {
    return undefined;
  }
  if (expression.type === "ObjectExpression") {
    return expression;
  }
  if (expression.type !== "Identifier") {
    return undefined;
  }
  for (const scope of [call, ...ancestors.toReversed()]) {
    if (scope.type === "BlockStatement" || scope.type === "Program") {
      for (const item of scope.body) {
        const statement =
          item.type === "ExportNamedDeclaration" ? item.declaration : item;
        if (statement?.type !== "VariableDeclaration") {
          continue;
        }
        for (const declaration of statement.declarations) {
          if (
            declaration.id.type !== "Identifier" ||
            declaration.id.name !== expression.name
          ) {
            continue;
          }
          const initializer = declaration.init;
          return statement.kind === "const" &&
            initializer?.type === "ObjectExpression"
            ? initializer
            : undefined;
        }
      }
      return undefined;
    }
    if (
      scope.type === "ArrowFunctionExpression" ||
      scope.type === "FunctionDeclaration" ||
      scope.type === "FunctionExpression"
    ) {
      return undefined;
    }
  }
  return undefined;
};

const literalPropertyName = ({
  computed,
  key,
}: ObjectProperty): string | undefined => {
  if (
    key.type === "Literal" &&
    (typeof key.value === "string" || typeof key.value === "number")
  ) {
    return String(key.value);
  }
  if (computed) {
    return key.type === "TemplateLiteral" && key.expressions.length === 0
      ? (key.quasis.at(0)?.value.cooked ?? undefined)
      : undefined;
  }
  return key.type === "Identifier" ? key.name : undefined;
};

const spreadCannotOverrideUnix = (expression: Node): boolean => {
  if (expression.type === "ParenthesizedExpression") {
    return spreadCannotOverrideUnix(expression.expression);
  }
  if (expression.type === "ConditionalExpression") {
    return (
      spreadCannotOverrideUnix(expression.consequent) &&
      spreadCannotOverrideUnix(expression.alternate)
    );
  }
  if (expression.type !== "ObjectExpression") {
    return false;
  }
  return expression.properties.every((property) => {
    if (property.type === "SpreadElement") {
      return spreadCannotOverrideUnix(property.argument);
    }
    const name = literalPropertyName(property);
    return name !== undefined && name !== "unix";
  });
};

const hasRequiredUnixSocket = (options: ObjectExpression | undefined) => {
  if (options === undefined) {
    return false;
  }
  for (const property of options.properties.toReversed()) {
    if (property.type === "SpreadElement") {
      if (!spreadCannotOverrideUnix(property.argument)) {
        return false;
      }
      continue;
    }
    const name = literalPropertyName(property);
    if (name === undefined) {
      return false;
    }
    if (name === "unix") {
      // `a?.b.socketPath` reads `socketPath` without its own `?.`.
      const value =
        property.value.type === "ChainExpression"
          ? property.value.expression
          : property.value;
      return (
        property.kind === "init" &&
        !property.method &&
        !property.shorthand &&
        value.type === "MemberExpression" &&
        !value.computed &&
        !value.optional &&
        value.property.type === "Identifier" &&
        value.property.name === "socketPath"
      );
    }
  }
  return false;
};

const fetchCalls = (source: ParsedSource) => {
  const calls: FetchCall[] = [];
  walk(source.program, (node, ancestors) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "fetch"
    ) {
      calls.push({ call: node, ancestors: [...ancestors] });
    }
  });
  return calls;
};

test.each([
  {
    source:
      'import type { createExec } from "./api"; type Factory = typeof createExec;',
    runtime: false,
  },
  {
    source:
      'import { type DockerConn } from "./api"; declare const unrelated: () => void; unrelated();',
    runtime: false,
  },
  { source: 'import { createExec } from "./api";', runtime: false },
  {
    source:
      'import { type DockerConn, createExec as exec } from "./api"; declare const args: Parameters<typeof exec>; exec(...args);',
    runtime: true,
  },
])(
  "Docker transport proof requires a referenced value import: $source",
  ({ source, runtime }) => {
    expect(hasDockerApiRuntimeCall(parseSource("provider.ts", source))).toBe(
      runtime,
    );
  },
);

test.each([
  "const requestOptions = { unix: connection.socketPath }; fetch(url, requestOptions);",
  "fetch(url, { unix: connection.socketPath });",
  'const requestOptions = { unix: connection.socketPath, ...(options.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }) }; fetch(url, requestOptions);',
  "fetch(url, { ...overrides, unix: connection.socketPath });",
])("Unix transport proof follows the actual options expression: %s", (text) => {
  const calls = fetchCalls(parseSource("api.ts", text));
  expect(calls).toHaveLength(1);
  expect(
    calls.every((call) => hasRequiredUnixSocket(fetchOptionsObject(call))),
  ).toBe(true);
});

test.each([
  "const options = {}; fetch(url, options);",
  "const options = { unix: undefined }; fetch(url, options);",
  "const options = { unix: connection.socketPath }; function send(options: RequestInit) { fetch(url, options); }",
  "fetch(url, { unix: connection.socketPath, ...overrides });",
  "fetch(url, { unix: connection.socketPath, [key]: undefined });",
  "fetch(url, { unix: connection.socketPath, unix: undefined });",
  'fetch(url, { unix: connection.socketPath, ["unix"]: undefined });',
  "fetch(url, { unix: connection.socketPath, ...(condition ? {} : { unix: undefined }) });",
])("unproven or shadowed options cannot certify Unix transport: %s", (text) => {
  const calls = fetchCalls(parseSource("api.ts", text));
  expect(calls).toHaveLength(1);
  expect(
    calls.every((call) => hasRequiredUnixSocket(fetchOptionsObject(call))),
  ).toBe(false);
});

test("Docker provider enrollment follows its required Unix fetch transport owner", () => {
  const provider = parseSource(
    "provider.ts",
    readFileSync(
      new URL(
        "../../packages/agent-engine/src/bun-docker/provider.ts",
        import.meta.url,
      ),
      "utf-8",
    ),
  );
  expect(hasDockerApiRuntimeCall(provider)).toBe(true);
  const source = parseSource(
    "api.ts",
    readFileSync(
      new URL(
        "../../packages/agent-engine/src/bun-docker/api.ts",
        import.meta.url,
      ),
      "utf-8",
    ),
  );
  const calls = fetchCalls(source);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(hasRequiredUnixSocket(fetchOptionsObject(call))).toBe(true);
  }
});
